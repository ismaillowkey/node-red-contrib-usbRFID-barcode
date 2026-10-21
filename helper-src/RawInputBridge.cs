// RawInputBridge - helper headless untuk node-red-contrib-usb-rfid.
//
// Menangkap input keyboard-wedge (USB RFID reader yang berperilaku seperti
// keyboard) memakai Windows Raw Input API + RIDEV_INPUTSINK. Pendekatan ini
// tidak membuka koleksi HID keyboard, sehingga tidak terkena error
// "Access is denied (0x5)" seperti pada node-hid.
//
// Protokol: satu objek JSON per baris pada stdout.
//   { "type": "ready",  ... }
//   { "type": "status", "state": "connected|disconnected", ... }
//   { "type": "scan",   "uid": "...", "device": {...}, ... }
//   { "type": "error",  "message": "..." }
//   { "type": "heartbeat", ... }
//   { "type": "stopped", ... }
//
// Perintah pada stdin (satu baris): "stop" atau {"cmd":"stop"}.
// Proses juga berhenti sendiri bila stdin ditutup atau parent PID hilang.

using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Drawing;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace UsbRfidRawInput
{
    internal static class VersionInfo
    {
        public const string Version = "1.0.0";
    }

    internal sealed class Options
    {
        public bool ShowHelp;
        public bool ShowVersion;
        public bool ListDevices;
        public bool Listen;
        public bool Any;
        public bool Strict;
        public bool Debug;
        public int? Vid;
        public int? Pid;
        public string DevicePath;
        public int IdleMs;
        public int ParentPid;
        public int DurationMs;

        public Options()
        {
            DevicePath = "";
            IdleMs = 250;
            ParentPid = 0;
            DurationMs = 0;
        }

        public bool HasFilter
        {
            get
            {
                return Any || Vid.HasValue || Pid.HasValue || !string.IsNullOrEmpty(DevicePath);
            }
        }

        public static Options Parse(string[] args)
        {
            Options options = new Options();

            for (int i = 0; i < args.Length; i++)
            {
                string arg = args[i] ?? "";
                string key = arg;
                string value = null;

                int equalsIndex = arg.IndexOf('=');
                if (equalsIndex > 0)
                {
                    key = arg.Substring(0, equalsIndex);
                    value = arg.Substring(equalsIndex + 1);
                }

                switch (key.ToLowerInvariant())
                {
                    case "--list":
                    case "-l":
                        options.ListDevices = true;
                        break;

                    case "--listen":
                        options.Listen = true;
                        break;

                    case "--any":
                    case "-a":
                        options.Any = true;
                        break;

                    case "--strict":
                        options.Strict = true;
                        break;

                    case "--debug":
                        options.Debug = true;
                        break;

                    case "--help":
                    case "-h":
                        options.ShowHelp = true;
                        break;

                    case "--version":
                        options.ShowVersion = true;
                        break;

                    case "--vid":
                        value = TakeValue(args, ref i, value, key);
                        options.Vid = ParseId(value, key);
                        break;

                    case "--pid":
                        value = TakeValue(args, ref i, value, key);
                        options.Pid = ParseId(value, key);
                        break;

                    case "--path":
                    case "--device-path":
                        value = TakeValue(args, ref i, value, key);
                        options.DevicePath = (value ?? "").Trim();
                        break;

                    case "--idle":
                        value = TakeValue(args, ref i, value, key);
                        options.IdleMs = ParseInteger(value, key);
                        break;

                    case "--parent-pid":
                        value = TakeValue(args, ref i, value, key);
                        options.ParentPid = ParseInteger(value, key);
                        break;

                    case "--duration":
                        value = TakeValue(args, ref i, value, key);
                        options.DurationMs = ParseInteger(value, key);
                        break;

                    default:
                        throw new ArgumentException("Argumen tidak dikenal: " + key);
                }
            }

            if (options.IdleMs < 50)
            {
                options.IdleMs = 50;
            }
            else if (options.IdleMs > 5000)
            {
                options.IdleMs = 5000;
            }

            if (options.ParentPid < 0)
            {
                throw new ArgumentException("Nilai --parent-pid tidak valid.");
            }

            if (options.DurationMs < 0)
            {
                throw new ArgumentException("Nilai --duration tidak valid.");
            }

            return options;
        }

        private static string TakeValue(string[] args, ref int index, string value, string key)
        {
            if (value != null)
            {
                return value;
            }

            if (index + 1 >= args.Length)
            {
                throw new ArgumentException("Nilai untuk " + key + " belum diisi.");
            }

            index++;
            return args[index];
        }

        private static int ParseId(string raw, string key)
        {
            string text = (raw ?? "").Trim();
            int value;
            bool ok;

            if (text.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
            {
                ok = int.TryParse(text.Substring(2), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out value);
            }
            else
            {
                ok = int.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out value);
            }

            if (!ok || value < 0 || value > 0xFFFF)
            {
                throw new ArgumentException("Nilai " + key + " tidak valid: " + raw);
            }

            return value;
        }

        private static int ParseInteger(string raw, string key)
        {
            int value;
            if (!int.TryParse((raw ?? "").Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out value))
            {
                throw new ArgumentException("Nilai " + key + " tidak valid: " + raw);
            }

            return value;
        }
    }

    internal sealed class DeviceInfo
    {
        public string Path { get; set; }
        public string Name { get; set; }
        public string DisplayName { get; set; }
        public int? VendorId { get; set; }
        public int? ProductId { get; set; }
        public uint DeviceType { get; set; }
        public string TypeName { get; set; }

        public DeviceInfo()
        {
            Path = "";
            Name = "";
            DisplayName = "";
            TypeName = "";
        }

        public bool IsKeyboard
        {
            get { return DeviceType == 1; }
        }
    }

    internal static class JsonOut
    {
        private static readonly object SyncRoot = new object();

        public static void Line(string json)
        {
            lock (SyncRoot)
            {
                try
                {
                    Console.Out.WriteLine(json);
                    Console.Out.Flush();
                }
                catch
                {
                    // stdout sudah ditutup (mis. Node-RED berhenti); biarkan
                    // timer parent/ stdin yang menghentikan proses.
                }
            }
        }

        public static string Quote(string value)
        {
            return "\"" + Escape(value) + "\"";
        }

        public static string Escape(string value)
        {
            if (value == null)
            {
                return "";
            }

            StringBuilder builder = new StringBuilder(value.Length + 8);
            for (int i = 0; i < value.Length; i++)
            {
                char c = value[i];
                switch (c)
                {
                    case '"':
                        builder.Append("\\\"");
                        break;
                    case '\\':
                        builder.Append("\\\\");
                        break;
                    case '\b':
                        builder.Append("\\b");
                        break;
                    case '\f':
                        builder.Append("\\f");
                        break;
                    case '\n':
                        builder.Append("\\n");
                        break;
                    case '\r':
                        builder.Append("\\r");
                        break;
                    case '\t':
                        builder.Append("\\t");
                        break;
                    default:
                        if (c < ' ')
                        {
                            builder.Append("\\u");
                            builder.Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        }
                        else
                        {
                            builder.Append(c);
                        }
                        break;
                }
            }

            return builder.ToString();
        }

        public static string HexId(int? value)
        {
            if (!value.HasValue)
            {
                return "";
            }

            return "0x" + value.Value.ToString("X4", CultureInfo.InvariantCulture);
        }

        public static string Device(DeviceInfo device)
        {
            if (device == null)
            {
                return "null";
            }

            StringBuilder builder = new StringBuilder();
            builder.Append("{");
            builder.Append("\"path\":").Append(Quote(device.Path)).Append(",");
            builder.Append("\"name\":").Append(Quote(device.Name)).Append(",");
            builder.Append("\"product\":").Append(Quote(device.Name)).Append(",");
            builder.Append("\"displayName\":").Append(Quote(device.DisplayName)).Append(",");
            builder.Append("\"vendorId\":").Append(device.VendorId.HasValue ? device.VendorId.Value.ToString(CultureInfo.InvariantCulture) : "null").Append(",");
            builder.Append("\"productId\":").Append(device.ProductId.HasValue ? device.ProductId.Value.ToString(CultureInfo.InvariantCulture) : "null").Append(",");
            builder.Append("\"vendorIdHex\":").Append(Quote(HexId(device.VendorId))).Append(",");
            builder.Append("\"productIdHex\":").Append(Quote(HexId(device.ProductId))).Append(",");
            builder.Append("\"type\":").Append(device.DeviceType.ToString(CultureInfo.InvariantCulture)).Append(",");
            builder.Append("\"typeName\":").Append(Quote(device.TypeName)).Append(",");
            builder.Append("\"keyboard\":").Append(device.IsKeyboard ? "true" : "false");
            builder.Append("}");
            return builder.ToString();
        }

        public static string List(List<DeviceInfo> devices)
        {
            StringBuilder builder = new StringBuilder();
            builder.Append("{\"type\":\"list\",\"backend\":\"rawinput\",\"count\":");
            builder.Append(devices.Count.ToString(CultureInfo.InvariantCulture));
            builder.Append(",\"devices\":[");

            for (int i = 0; i < devices.Count; i++)
            {
                if (i > 0)
                {
                    builder.Append(",");
                }
                builder.Append(Device(devices[i]));
            }

            builder.Append("]}");
            return builder.ToString();
        }

        public static string Error(string message)
        {
            return "{\"type\":\"error\",\"message\":" + Quote(message) + "}";
        }

        public static string Info(string message)
        {
            return "{\"type\":\"info\",\"message\":" + Quote(message) + "}";
        }

        public static string Status(string state, DeviceInfo device, string message)
        {
            StringBuilder builder = new StringBuilder();
            builder.Append("{\"type\":\"status\",\"state\":").Append(Quote(state));
            if (device != null)
            {
                builder.Append(",\"device\":").Append(Device(device));
            }
            if (!string.IsNullOrEmpty(message))
            {
                builder.Append(",\"message\":").Append(Quote(message));
            }
            builder.Append(",\"timestamp\":").Append(Quote(Timestamp()));
            builder.Append("}");
            return builder.ToString();
        }

        public static string Scan(string uid, DeviceInfo device)
        {
            StringBuilder builder = new StringBuilder();
            builder.Append("{\"type\":\"scan\",\"uid\":").Append(Quote(uid));
            builder.Append(",\"source\":\"keyboard\"");
            if (device != null)
            {
                builder.Append(",\"device\":").Append(Device(device));
            }
            builder.Append(",\"timestamp\":").Append(Quote(Timestamp()));
            builder.Append("}");
            return builder.ToString();
        }

        public static string Timestamp()
        {
            return DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture);
        }
    }

    internal static class RawInputApi
    {
        public const int WM_INPUT = 0x00FF;
        public const uint RID_INPUT = 0x10000003;
        public const uint RIDI_DEVICENAME = 0x20000007;
        public const ushort HID_USAGE_PAGE_GENERIC = 0x01;
        public const ushort HID_USAGE_GENERIC_KEYBOARD = 0x06;
        public const uint RIDEV_INPUTSINK = 0x00000100;
        public const uint RIDEV_REMOVE = 0x00000001;
        public const ushort RI_KEY_BREAK = 1;

        [StructLayout(LayoutKind.Sequential)]
        public struct RAWINPUTDEVICELIST
        {
            public IntPtr hDevice;
            public uint dwType;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct RAWINPUTDEVICE
        {
            public ushort usUsagePage;
            public ushort usUsage;
            public uint dwFlags;
            public IntPtr hwndTarget;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct RAWINPUTHEADER
        {
            public uint dwType;
            public uint dwSize;
            public IntPtr hDevice;
            public IntPtr wParam;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct RAWKEYBOARD
        {
            public ushort MakeCode;
            public ushort Flags;
            public ushort Reserved;
            public ushort VKey;
            public uint Message;
            public uint ExtraInformation;
        }

        [DllImport("user32.dll", SetLastError = true)]
        public static extern uint GetRawInputDeviceList(
            [In, Out] RAWINPUTDEVICELIST[] pRawInputDeviceList,
            ref uint puiNumDevices,
            uint cbSize);

        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Ansi)]
        public static extern uint GetRawInputDeviceInfoA(
            IntPtr hDevice,
            uint uiCommand,
            StringBuilder pData,
            ref uint pcbSize);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool RegisterRawInputDevices(
            [In] RAWINPUTDEVICE[] pRawInputDevices,
            uint uiNumDevices,
            uint cbSize);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern uint GetRawInputData(
            IntPtr hRawInput,
            uint uiCommand,
            IntPtr pData,
            ref uint pcbSize,
            uint cbSizeHeader);

        [DllImport("user32.dll")]
        public static extern uint MapVirtualKey(uint uCode, uint uMapType);

        private static readonly Regex VidPidRegex = new Regex(
            "VID_([0-9A-Fa-f]{4})&PID_([0-9A-Fa-f]{4})",
            RegexOptions.IgnoreCase | RegexOptions.Compiled);

        public static List<DeviceInfo> EnumerateDevices()
        {
            List<DeviceInfo> result = new List<DeviceInfo>();
            uint count = 0;
            uint structSize = (uint)Marshal.SizeOf(typeof(RAWINPUTDEVICELIST));

            uint first = GetRawInputDeviceList(null, ref count, structSize);
            if (first == uint.MaxValue || count == 0)
            {
                return result;
            }

            RAWINPUTDEVICELIST[] list = new RAWINPUTDEVICELIST[count];
            uint actual = GetRawInputDeviceList(list, ref count, structSize);
            if (actual == uint.MaxValue)
            {
                return result;
            }

            for (int i = 0; i < list.Length && i < count; i++)
            {
                string path = GetDevicePathByHandle(list[i].hDevice);
                if (string.IsNullOrEmpty(path))
                {
                    continue;
                }

                string upperPath = path.ToUpperInvariant();
                if (upperPath.IndexOf("HID#", StringComparison.Ordinal) < 0 &&
                    upperPath.IndexOf("USB#", StringComparison.Ordinal) < 0)
                {
                    continue;
                }

                result.Add(BuildDeviceInfo(path, list[i].dwType));
            }

            result.Sort(CompareDevices);
            return result;
        }

        private static int CompareDevices(DeviceInfo a, DeviceInfo b)
        {
            if (a.IsKeyboard != b.IsKeyboard)
            {
                return a.IsKeyboard ? -1 : 1;
            }

            int nameCompare = string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase);
            if (nameCompare != 0)
            {
                return nameCompare;
            }

            int vidCompare = Nullable.Compare(a.VendorId, b.VendorId);
            if (vidCompare != 0)
            {
                return vidCompare;
            }

            int pidCompare = Nullable.Compare(a.ProductId, b.ProductId);
            if (pidCompare != 0)
            {
                return pidCompare;
            }

            return string.Compare(a.Path, b.Path, StringComparison.OrdinalIgnoreCase);
        }

        public static string GetDevicePathByHandle(IntPtr hDevice)
        {
            uint charCount = 0;
            GetRawInputDeviceInfoA(hDevice, RIDI_DEVICENAME, null, ref charCount);
            if (charCount == 0)
            {
                return "";
            }

            StringBuilder builder = new StringBuilder((int)charCount + 1);
            uint result = GetRawInputDeviceInfoA(hDevice, RIDI_DEVICENAME, builder, ref charCount);
            if (result == uint.MaxValue)
            {
                return "";
            }

            return builder.ToString();
        }

        public static DeviceInfo BuildDeviceInfo(string path, uint deviceType)
        {
            DeviceInfo device = new DeviceInfo();
            device.Path = path;
            device.DeviceType = deviceType;
            device.Name = GetDeviceFriendlyName(path);

            if (deviceType == 1)
            {
                device.TypeName = "Keyboard";
            }
            else if (deviceType == 2)
            {
                device.TypeName = "HID";
            }
            else
            {
                device.TypeName = "Mouse";
            }

            int vid;
            int pid;
            if (TryParseVidPid(path, out vid, out pid))
            {
                device.VendorId = vid;
                device.ProductId = pid;
            }

            string label = device.Name;
            if (device.VendorId.HasValue && device.ProductId.HasValue)
            {
                label += " (VID:" + device.VendorId.Value.ToString("X4", CultureInfo.InvariantCulture);
                label += " PID:" + device.ProductId.Value.ToString("X4", CultureInfo.InvariantCulture) + ")";
            }

            if (device.IsKeyboard)
            {
                label += " [Keyboard]";
            }
            else if (device.DeviceType == 2)
            {
                label += " [HID]";
            }
            else
            {
                label += " [Mouse]";
            }

            device.DisplayName = label;
            return device;
        }

        public static bool TryParseVidPid(string path, out int vid, out int pid)
        {
            vid = 0;
            pid = 0;

            if (string.IsNullOrEmpty(path))
            {
                return false;
            }

            Match match = VidPidRegex.Match(path);
            if (!match.Success)
            {
                return false;
            }

            if (!int.TryParse(match.Groups[1].Value, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out vid))
            {
                return false;
            }

            if (!int.TryParse(match.Groups[2].Value, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out pid))
            {
                return false;
            }

            return true;
        }

        public static string InstanceKey(string path)
        {
            if (string.IsNullOrEmpty(path))
            {
                return "";
            }

            string key = path;
            int guidIndex = key.IndexOf("#{", StringComparison.Ordinal);
            if (guidIndex > 0)
            {
                key = key.Substring(0, guidIndex);
            }

            if (key.EndsWith("\\KBD", StringComparison.OrdinalIgnoreCase))
            {
                key = key.Substring(0, key.Length - 4);
            }

            return key;
        }

        public static bool MatchesPath(Options options, string path)
        {
            if (options.Any)
            {
                return true;
            }

            if (!string.IsNullOrEmpty(options.DevicePath))
            {
                if (string.Equals(path, options.DevicePath, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }

                if (string.Equals(InstanceKey(path), InstanceKey(options.DevicePath), StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }

                int optVid, optPid;
                if (TryParseVidPid(options.DevicePath, out optVid, out optPid))
                {
                    int pathVid, pathPid;
                    if (TryParseVidPid(path, out pathVid, out pathPid))
                    {
                        if (optVid == pathVid && optPid == pathPid)
                        {
                            return true;
                        }
                    }
                }
            }

            if (options.Vid.HasValue || options.Pid.HasValue)
            {
                int vid;
                int pid;
                if (TryParseVidPid(path, out vid, out pid))
                {
                    if (options.Vid.HasValue && vid != options.Vid.Value)
                    {
                        return false;
                    }

                    if (options.Pid.HasValue && pid != options.Pid.Value)
                    {
                        return false;
                    }

                    return true;
                }
            }

            return false;
        }

        public static bool DeviceMatches(Options options, DeviceInfo device, bool requireKeyboard)
        {
            if (device == null)
            {
                return false;
            }

            if (options.Any)
            {
                return !requireKeyboard || device.IsKeyboard;
            }

            if (requireKeyboard && !device.IsKeyboard)
            {
                return false;
            }

            if (!string.IsNullOrEmpty(options.DevicePath))
            {
                if (string.Equals(device.Path, options.DevicePath, StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(InstanceKey(device.Path), InstanceKey(options.DevicePath), StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }

                int optVid, optPid;
                if (TryParseVidPid(options.DevicePath, out optVid, out optPid))
                {
                    if (device.VendorId.HasValue && device.ProductId.HasValue)
                    {
                        if (device.VendorId.Value == optVid && device.ProductId.Value == optPid)
                        {
                            return true;
                        }
                    }
                }
            }

            if (options.Vid.HasValue || options.Pid.HasValue)
            {
                if (options.Vid.HasValue && device.VendorId != options.Vid)
                {
                    return false;
                }

                if (options.Pid.HasValue && device.ProductId != options.Pid)
                {
                    return false;
                }

                return true;
            }

            return false;
        }

        public static DeviceInfo FindTargetDevice(Options options)
        {
            List<DeviceInfo> devices = EnumerateDevices();

            for (int i = 0; i < devices.Count; i++)
            {
                if (DeviceMatches(options, devices[i], true))
                {
                    return devices[i];
                }
            }

            for (int i = 0; i < devices.Count; i++)
            {
                if (DeviceMatches(options, devices[i], false))
                {
                    return devices[i];
                }
            }

            return null;
        }

        public static string GetDeviceFriendlyName(string path)
        {
            try
            {
                string cleanPath = path ?? "";
                if (cleanPath.StartsWith("\\\\?\\", StringComparison.Ordinal))
                {
                    cleanPath = cleanPath.Substring(4);
                }

                string[] parts = cleanPath.Split('#');
                if (parts.Length >= 3)
                {
                    string subKeyPath = "SYSTEM\\CurrentControlSet\\Enum\\" + parts[0] + "\\" + parts[1] + "\\" + parts[2];
                    using (RegistryKey regKey = Registry.LocalMachine.OpenSubKey(subKeyPath))
                    {
                        if (regKey != null)
                        {
                            object friendlyValue = regKey.GetValue("FriendlyName");
                            string friendlyName = CleanRegistryName(friendlyValue);
                            if (!string.IsNullOrEmpty(friendlyName))
                            {
                                return friendlyName;
                            }

                            object descValue = regKey.GetValue("DeviceDesc");
                            string deviceDesc = CleanRegistryName(descValue);
                            if (!string.IsNullOrEmpty(deviceDesc))
                            {
                                return deviceDesc;
                            }
                        }
                    }
                }
            }
            catch
            {
                // Registry tidak dapat dibaca: gunakan nama fallback.
            }

            return "USB HID Device";
        }

        private static string CleanRegistryName(object value)
        {
            if (value == null)
            {
                return "";
            }

            string text = value.ToString().Trim();
            if (text.Length == 0)
            {
                return "";
            }

            // Format DeviceDesc biasanya "path,-resourceId;Nama Perangkat".
            int semicolonIndex = text.LastIndexOf(';');
            if (semicolonIndex >= 0 && semicolonIndex < text.Length - 1)
            {
                text = text.Substring(semicolonIndex + 1).Trim();
            }

            return text;
        }
    }

    internal sealed class BridgeForm : Form
    {
        private const int MaxBufferLength = 512;

        private readonly Options _options;
        private readonly System.Windows.Forms.Timer _flushTimer;
        private readonly System.Windows.Forms.Timer _monitorTimer;
        private readonly System.Windows.Forms.Timer _heartbeatTimer;
        private readonly System.Windows.Forms.Timer _parentTimer;
        private readonly StringBuilder _buffer;
        private readonly Dictionary<string, DeviceInfo> _deviceCache;

        private DeviceInfo _targetDevice;
        private DeviceInfo _lastInputDevice;
        private bool _connected;
        private bool _registered;
        private bool _closing;
        private int _stopRequested;
        private DateTime _startedUtc;

        public BridgeForm(Options options)
        {
            _options = options;
            _buffer = new StringBuilder();
            _deviceCache = new Dictionary<string, DeviceInfo>(StringComparer.OrdinalIgnoreCase);

            Text = "RawInputBridge";
            ShowInTaskbar = false;
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            Location = new Point(-32000, -32000);
            Size = new Size(1, 1);
            Opacity = 0.0;
            ShowIcon = false;
            MinimizeBox = false;
            MaximizeBox = false;

            _flushTimer = new System.Windows.Forms.Timer();
            _flushTimer.Interval = options.IdleMs;
            _flushTimer.Tick += delegate
            {
                _flushTimer.Stop();
                FlushBuffer();
            };

            _monitorTimer = new System.Windows.Forms.Timer();
            _monitorTimer.Interval = 2000;
            _monitorTimer.Tick += delegate { MonitorDevices(); };

            _heartbeatTimer = new System.Windows.Forms.Timer();
            _heartbeatTimer.Interval = 5000;
            _heartbeatTimer.Tick += delegate { SendHeartbeat(); };

            _parentTimer = new System.Windows.Forms.Timer();
            _parentTimer.Interval = 1000;
            _parentTimer.Tick += delegate { CheckParentAndDuration(); };
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);

            if (_closing)
            {
                return;
            }

            StartBridge();
        }

        private void StartBridge()
        {
            _startedUtc = DateTime.UtcNow;
            _targetDevice = RawInputApi.FindTargetDevice(_options);
            _connected = _targetDevice != null;

            if (!RegisterRawInput())
            {
                RequestStop("register-failed");
                return;
            }

            JsonOut.Line(BuildReadyJson());
            JsonOut.Line(JsonOut.Status(
                _connected ? "connected" : "disconnected",
                _targetDevice,
                _connected ? null : "Perangkat belum ditemukan; menunggu..."));

            _monitorTimer.Start();
            _heartbeatTimer.Start();
            _parentTimer.Start();

            StartStdinWatcher();
        }

        private string BuildReadyJson()
        {
            StringBuilder builder = new StringBuilder();
            builder.Append("{\"type\":\"ready\",\"version\":").Append(JsonOut.Quote(VersionInfo.Version));
            builder.Append(",\"pid\":").Append(System.Diagnostics.Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture));
            builder.Append(",\"any\":").Append(_options.Any ? "true" : "false");
            builder.Append(",\"strict\":").Append(_options.Strict ? "true" : "false");
            builder.Append(",\"idleMs\":").Append(_options.IdleMs.ToString(CultureInfo.InvariantCulture));
            builder.Append(",\"vid\":").Append(_options.Vid.HasValue ? _options.Vid.Value.ToString(CultureInfo.InvariantCulture) : "null");
            builder.Append(",\"pidFilter\":").Append(_options.Pid.HasValue ? _options.Pid.Value.ToString(CultureInfo.InvariantCulture) : "null");
            builder.Append(",\"path\":").Append(JsonOut.Quote(_options.DevicePath));
            builder.Append(",\"device\":").Append(JsonOut.Device(_targetDevice));
            builder.Append("}");
            return builder.ToString();
        }

        private bool RegisterRawInput()
        {
            try
            {
                RawInputApi.RAWINPUTDEVICE[] devices = new RawInputApi.RAWINPUTDEVICE[1];
                devices[0].usUsagePage = RawInputApi.HID_USAGE_PAGE_GENERIC;
                devices[0].usUsage = RawInputApi.HID_USAGE_GENERIC_KEYBOARD;
                devices[0].dwFlags = RawInputApi.RIDEV_INPUTSINK;
                devices[0].hwndTarget = Handle;

                bool ok = RawInputApi.RegisterRawInputDevices(
                    devices,
                    1,
                    (uint)Marshal.SizeOf(typeof(RawInputApi.RAWINPUTDEVICE)));

                if (!ok)
                {
                    int errorCode = Marshal.GetLastWin32Error();
                    string message = new Win32Exception(errorCode).Message;
                    JsonOut.Line(JsonOut.Error(
                        "Gagal mendaftarkan Raw Input (kode " + errorCode.ToString(CultureInfo.InvariantCulture) + "): " + message));
                    return false;
                }

                _registered = true;
                return true;
            }
            catch (Exception ex)
            {
                JsonOut.Line(JsonOut.Error("Gagal mendaftarkan Raw Input: " + ex.Message));
                return false;
            }
        }

        private void UnregisterRawInput()
        {
            if (!_registered)
            {
                return;
            }

            try
            {
                RawInputApi.RAWINPUTDEVICE[] devices = new RawInputApi.RAWINPUTDEVICE[1];
                devices[0].usUsagePage = RawInputApi.HID_USAGE_PAGE_GENERIC;
                devices[0].usUsage = RawInputApi.HID_USAGE_GENERIC_KEYBOARD;
                devices[0].dwFlags = RawInputApi.RIDEV_REMOVE;
                devices[0].hwndTarget = IntPtr.Zero;

                RawInputApi.RegisterRawInputDevices(
                    devices,
                    1,
                    (uint)Marshal.SizeOf(typeof(RawInputApi.RAWINPUTDEVICE)));
            }
            catch
            {
                // Abaikan kegagalan saat proses berhenti.
            }

            _registered = false;
        }

        private void StopRuntime()
        {
            _flushTimer.Stop();
            _monitorTimer.Stop();
            _heartbeatTimer.Stop();
            _parentTimer.Stop();
            _buffer.Length = 0;
            UnregisterRawInput();
        }

        private void RequestStop(string reason)
        {
            if (Interlocked.Exchange(ref _stopRequested, 1) != 0)
            {
                return;
            }

            try
            {
                if (IsHandleCreated)
                {
                    BeginInvoke(new Action<string>(StopBridge), new object[] { reason });
                    return;
                }
            }
            catch
            {
                // Lanjutkan dengan penghentian langsung.
            }

            StopBridge(reason);
        }

        private void StopBridge(string reason)
        {
            if (_closing)
            {
                return;
            }

            _closing = true;
            StopRuntime();

            string json = "{\"type\":\"stopped\",\"reason\":" + JsonOut.Quote(reason) + "}";
            JsonOut.Line(json);

            try
            {
                Close();
            }
            catch
            {
                // Abaikan.
            }

            Application.ExitThread();
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            _closing = true;
            StopRuntime();
            base.OnFormClosing(e);
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == RawInputApi.WM_INPUT)
            {
                ProcessRawInput(m.LParam);
            }

            base.WndProc(ref m);
        }

        private void ProcessRawInput(IntPtr lParam)
        {
            if (_closing)
            {
                return;
            }

            uint size = 0;
            uint headerSize = (uint)Marshal.SizeOf(typeof(RawInputApi.RAWINPUTHEADER));

            RawInputApi.GetRawInputData(lParam, RawInputApi.RID_INPUT, IntPtr.Zero, ref size, headerSize);
            if (size == 0)
            {
                return;
            }

            IntPtr data = Marshal.AllocHGlobal((int)size);
            try
            {
                uint copied = RawInputApi.GetRawInputData(lParam, RawInputApi.RID_INPUT, data, ref size, headerSize);
                if (copied == 0 || copied == uint.MaxValue)
                {
                    return;
                }

                RawInputApi.RAWINPUTHEADER header =
                    (RawInputApi.RAWINPUTHEADER)Marshal.PtrToStructure(data, typeof(RawInputApi.RAWINPUTHEADER));

                if (header.dwType != 1)
                {
                    return;
                }

                string inputPath = "";
                if (header.hDevice != IntPtr.Zero)
                {
                    inputPath = RawInputApi.GetDevicePathByHandle(header.hDevice);
                }

                if (_options.Debug)
                {
                    JsonOut.Line("{\"type\":\"debug\",\"event\":\"wm_input\",\"hwnd\":" +
                        Handle.ToInt64().ToString(CultureInfo.InvariantCulture) +
                        ",\"hDevice\":" + header.hDevice.ToInt64().ToString(CultureInfo.InvariantCulture) +
                        ",\"path\":" + JsonOut.Quote(inputPath) + "}");
                }

                if (!IsInputAccepted(header.hDevice, inputPath))
                {
                    return;
                }

                IntPtr keyboardPointer = new IntPtr(data.ToInt64() + Marshal.SizeOf(typeof(RawInputApi.RAWINPUTHEADER)));
                RawInputApi.RAWKEYBOARD keyboard =
                    (RawInputApi.RAWKEYBOARD)Marshal.PtrToStructure(keyboardPointer, typeof(RawInputApi.RAWKEYBOARD));

                bool isKeyDown = ((keyboard.Flags & RawInputApi.RI_KEY_BREAK) == 0);
                if (!isKeyDown)
                {
                    return;
                }

                ushort vKey = keyboard.VKey;
                ushort makeCode = keyboard.MakeCode;

                // Beberapa reader keyboard-wedge hanya mengirim MakeCode.
                if (vKey == 0 || vKey == 0xFF || vKey == 0xE7)
                {
                    if (makeCode > 0)
                    {
                        uint mappedKey = RawInputApi.MapVirtualKey(makeCode, 1);
                        if (mappedKey > 0)
                        {
                            vKey = (ushort)mappedKey;
                        }
                    }
                }

                _lastInputDevice = GetDeviceForInput(header.hDevice, inputPath);
                HandleKeyDown(vKey, makeCode);
            }
            catch
            {
                // Jangan biarkan satu pesan rusak mematikan listener.
            }
            finally
            {
                Marshal.FreeHGlobal(data);
            }
        }

        private bool IsInputAccepted(IntPtr hDevice, string path)
        {
            if (_options.Any)
            {
                return true;
            }

            if (hDevice == IntPtr.Zero)
            {
                // Driver keyboard-wedge generik kadang melaporkan handle nol.
                // Mode default tetap menerima input ketikan keyboard.
                return !_options.Strict;
            }

            if (string.IsNullOrEmpty(path))
            {
                return false;
            }

            return RawInputApi.MatchesPath(_options, path);
        }

        private DeviceInfo GetDeviceForInput(IntPtr hDevice, string path)
        {
            if (string.IsNullOrEmpty(path))
            {
                return _targetDevice;
            }

            DeviceInfo cached;
            if (_deviceCache.TryGetValue(path, out cached))
            {
                return cached;
            }

            DeviceInfo device = RawInputApi.BuildDeviceInfo(path, 1);
            _deviceCache[path] = device;
            return device;
        }


        private void HandleKeyDown(ushort vKey, ushort makeCode)
        {
            if (vKey == 0x0D || vKey == 0x0A || makeCode == 0x1C)
            {
                _flushTimer.Stop();
                FlushBuffer();
                return;
            }

            char mappedChar = ConvertVirtualKeyToChar(vKey);

            if (mappedChar == '\0' && makeCode > 0)
            {
                uint vkFromMakeCode = RawInputApi.MapVirtualKey(makeCode, 1);
                if (vkFromMakeCode > 0)
                {
                    mappedChar = ConvertVirtualKeyToChar((ushort)vkFromMakeCode);
                }
            }

            if (mappedChar == '\n' || mappedChar == '\r')
            {
                _flushTimer.Stop();
                FlushBuffer();
                return;
            }

            if (mappedChar == '\0')
            {
                return;
            }

            if (_buffer.Length >= MaxBufferLength)
            {
                _buffer.Length = 0;
                JsonOut.Line(JsonOut.Info("Buffer scan melebihi batas; data dibuang."));
            }

            _buffer.Append(mappedChar);
            _flushTimer.Stop();
            _flushTimer.Start();
        }

        private static char ConvertVirtualKeyToChar(ushort vKey)
        {
            if (vKey >= 0x30 && vKey <= 0x39)
            {
                return (char)('0' + (vKey - 0x30));
            }

            if (vKey >= 0x60 && vKey <= 0x69)
            {
                return (char)('0' + (vKey - 0x60));
            }

            if (vKey >= 0x41 && vKey <= 0x5A)
            {
                return (char)('A' + (vKey - 0x41));
            }

            uint charValue = RawInputApi.MapVirtualKey(vKey, 2);
            if (charValue > 0)
            {
                char c = (char)charValue;
                if (!char.IsControl(c) || c == '\n' || c == '\r')
                {
                    return c;
                }
            }

            return '\0';
        }

        private void FlushBuffer()
        {
            _flushTimer.Stop();

            DeviceInfo device = (_lastInputDevice != null) ? _lastInputDevice : _targetDevice;
            _lastInputDevice = null;

            if (_buffer.Length == 0)
            {
                return;
            }

            string uid = _buffer.ToString().Trim();
            _buffer.Length = 0;

            if (uid.Length == 0)
            {
                return;
            }

            JsonOut.Line(JsonOut.Scan(uid, device));
        }


        private void StartStdinWatcher()
        {
            Thread thread = new Thread(StdinLoop);
            thread.IsBackground = true;
            thread.Name = "RawInputBridgeStdin";
            thread.Start();
        }

        private void StdinLoop()
        {
            try
            {
                string line;
                while ((line = Console.In.ReadLine()) != null)
                {
                    string text = (line ?? "").Trim();
                    if (text.Length == 0)
                    {
                        continue;
                    }

                    if (string.Equals(text, "stop", StringComparison.OrdinalIgnoreCase) ||
                        text.IndexOf("\"cmd\":\"stop\"", StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        RequestStop("stdin-stop");
                        return;
                    }

                    if (text.IndexOf("\"cmd\":\"ping\"", StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        JsonOut.Line("{\"type\":\"pong\",\"timestamp\":" + JsonOut.Quote(JsonOut.Timestamp()) + "}");
                    }
                }
            }
            catch
            {
                // stdin tidak tersedia / sudah ditutup.
            }

            RequestStop("stdin-closed");
        }

        private void MonitorDevices()
        {
            if (_closing)
            {
                return;
            }

            DeviceInfo found = RawInputApi.FindTargetDevice(_options);
            bool present = found != null && (!_options.Any || found.IsKeyboard);

            if (present)
            {
                _targetDevice = found;
            }

            if (present && !_connected)
            {
                _connected = true;
                _deviceCache.Clear();
                JsonOut.Line(JsonOut.Status("connected", _targetDevice, null));
            }
            else if (!present && _connected)
            {
                _connected = false;
                _flushTimer.Stop();
                _buffer.Length = 0;
                _lastInputDevice = null;
                JsonOut.Line(JsonOut.Status("disconnected", null, "Perangkat terputus"));
            }
        }

        private void SendHeartbeat()
        {
            if (_closing)
            {
                return;
            }

            JsonOut.Line("{\"type\":\"heartbeat\",\"timestamp\":" + JsonOut.Quote(JsonOut.Timestamp()) + "}");
        }

        private void CheckParentAndDuration()
        {
            if (_closing)
            {
                return;
            }

            if (_options.DurationMs > 0)
            {
                double elapsed = (DateTime.UtcNow - _startedUtc).TotalMilliseconds;
                if (elapsed >= _options.DurationMs)
                {
                    RequestStop("duration-elapsed");
                    return;
                }
            }

            if (_options.ParentPid > 0)
            {
                try
                {
                    using (System.Diagnostics.Process parent = System.Diagnostics.Process.GetProcessById(_options.ParentPid))
                    {
                        // Proses induk masih hidup.
                    }
                }
                catch
                {
                    RequestStop("parent-exited");
                }
            }
        }
    }


    internal static class Program
    {
        private const string HelpText =
            "RawInputBridge " + VersionInfo.Version + "\n" +
            "\n" +
            "Pemakaian:\n" +
            "  RawInputBridge.exe --list\n" +
            "  RawInputBridge.exe --listen [--vid=0xFFFF --pid=0x0035] [--path=<device path>]\n" +
            "                     [--any] [--idle=250] [--parent-pid=<pid>] [--duration=<ms>] [--strict]\n" +
            "\n" +
            "Mode:\n" +
            "  --list              Cetak daftar perangkat Raw Input sebagai JSON lalu keluar.\n" +
            "  --listen            Mulai menangkap keyboard. Wajib memakai --any/--vid/--pid/--path.\n" +
            "  --any               Terima semua keyboard (termasuk keyboard komputer).\n" +
            "  --vid / --pid       Filter VID/PID (heksadesimal atau desimal).\n" +
            "  --path              Filter path perangkat Raw Input (bisa juga prefix instance).\n" +
            "  --idle              Jeda flush otomatis dalam ms (default 250).\n" +
            "  --parent-pid        Keluar otomatis bila proses induk sudah tidak ada.\n" +
            "  --duration          Berhenti otomatis setelah N ms (untuk pengujian).\n" +
            "  --strict            Tolak input dengan handle perangkat nol (injected input).\n" +
            "  --debug             Tulis setiap WM_INPUT ke stdout (untuk troubleshooting).\n" +
            "\n" +
            "Contoh:\n" +
            "  RawInputBridge.exe --listen --vid=0xFFFF --pid=0x0035\n" +
            "  RawInputBridge.exe --listen --path=\"\\\\?\\HID#VID_FFFF&PID_0035&MI_00#...\"\n";

        [STAThread]
        private static int Main(string[] args)
        {
            try
            {
                Console.OutputEncoding = new UTF8Encoding(false);
            }
            catch
            {
                // Biarkan encoding default bila stdout tidak mendukung UTF-8.
            }

            Options options;
            try
            {
                options = Options.Parse(args);
            }
            catch (Exception ex)
            {
                JsonOut.Line(JsonOut.Error(ex.Message));
                return 2;
            }

            if (options.ShowHelp)
            {
                Console.WriteLine(HelpText);
                return 0;
            }

            if (options.ShowVersion)
            {
                JsonOut.Line("{\"type\":\"version\",\"version\":" + JsonOut.Quote(VersionInfo.Version) + "}");
                return 0;
            }

            if (options.ListDevices)
            {
                JsonOut.Line(JsonOut.List(RawInputApi.EnumerateDevices()));
                return 0;
            }

            if (!options.Listen)
            {
                JsonOut.Line(JsonOut.Error("Gunakan --list atau --listen. Jalankan --help untuk bantuan."));
                return 2;
            }

            if (!options.HasFilter)
            {
                JsonOut.Line(JsonOut.Error("Mode --listen memerlukan --any, --vid/--pid, atau --path."));
                return 2;
            }

            AppDomain.CurrentDomain.UnhandledException += delegate(object sender, UnhandledExceptionEventArgs eventArgs)
            {
                Exception ex = eventArgs.ExceptionObject as Exception;
                JsonOut.Line(JsonOut.Error("Unhandled: " + (ex != null ? ex.Message : "unknown")));
            };

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
            Application.ThreadException += delegate(object sender, ThreadExceptionEventArgs eventArgs)
            {
                JsonOut.Line(JsonOut.Error("UI thread: " + eventArgs.Exception.Message));
            };

            Application.Run(new BridgeForm(options));
            return 0;
        }
    }

}
