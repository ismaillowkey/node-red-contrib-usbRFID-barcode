module.exports = function (RED) {
    'use strict';

    const fs = require('fs');
    const path = require('path');
    const rawInputBackend = require('./lib/raw-input-backend');
    const toHex = rawInputBackend.toHex;

    // Nilai default bila konfigurasi tidak diisi
    const DEFAULT_VID = 0xFFFF;
    const DEFAULT_PID = 0x0035;
    const RAW_INPUT_HELPER = path.join(__dirname, 'bin', 'win', 'RawInputBridge.exe');

    // Mengubah data Raw Input dari helper menjadi format dropdown editor
    function describeRawInputDevices(rawDevices) {
        let list = rawDevices;
        if (!list) {
            list = [];
        }

        let devices = list.map(function (dev) {
            return rawInputBackend.normalizeDevice(dev);
        }).filter(function (dev) {
            // Hanya tampilkan perangkat keyboard / wedge
            if (dev.path && dev.path.length > 0 && dev.keyboard === true) {
                return true;
            }
            return false;
        });

        devices.sort(function (a, b) {
            let labelA = '';
            if (a.label) {
                labelA = a.label.toLowerCase();
            }

            let labelB = '';
            if (b.label) {
                labelB = b.label.toLowerCase();
            }

            if (labelA < labelB) {
                return -1;
            }
            if (labelA > labelB) {
                return 1;
            }

            if (a.path < b.path) {
                return -1;
            }
            if (a.path > b.path) {
                return 1;
            }
            return 0;
        });

        return devices;
    }

    // Endpoint admin: dipakai editor untuk mengisi dropdown perangkat + tombol Refresh
    RED.httpAdmin.get('/usb-rfid/devices', RED.auth.needsPermission('usb-rfid.read'), function (req, res) {
        res.set('Cache-Control', 'no-store');

        const helperExe = rawInputBackend.findRawInputBridge(RAW_INPUT_HELPER);
        if (!helperExe || !fs.existsSync(helperExe)) {
            res.json({
                count: 0,
                devices: []
            });
            return;
        }

        rawInputBackend.listDevices(helperExe, function (err, rawDevices) {
            if (err) {
                res.status(500).json({
                    error: err.message,
                    count: 0,
                    devices: []
                });
                return;
            }

            let devices = describeRawInputDevices(rawDevices);
            res.json({
                count: devices.length,
                devices: devices
            });
        });
    });

    // Endpoint admin: melayani gambar fisik USB RFID Reader untuk tampilan editor
    RED.httpAdmin.get('/usb-rfid/reader-image', function (req, res) {
        const imagePath = path.join(__dirname, 'resources', 'rfid-reader.png');
        if (fs.existsSync(imagePath)) {
            res.sendFile(imagePath);
            return;
        }
        res.status(404).end();
    });

    // Parse VID/PID dari string ("0xFFFF" / "65535") atau angka
    function parseUsbId(raw, fallback) {
        if (typeof raw === 'number' && isFinite(raw)) {
            let num = Math.trunc(raw);
            if (num >= 0 && num <= 0xFFFF) {
                return num;
            }
            return fallback;
        }

        if (typeof raw !== 'string') {
            return fallback;
        }

        let clean = raw.trim();
        if (clean.length === 0) {
            return fallback;
        }

        let value;
        if (/^0x[0-9a-f]+$/i.test(clean)) {
            value = parseInt(clean, 16);
        } else if (/^[0-9]+$/.test(clean)) {
            value = parseInt(clean, 10);
        } else {
            return null;
        }

        if (!isFinite(value) || value < 0 || value > 0xFFFF) {
            return null;
        }

        return value;
    }

    function UsbRfidNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.name = config.name;

        // Mode pemilihan perangkat:
        //  auto     -> cocokkan VID & PID
        //  selected -> perangkat tertentu dari dropdown editor
        //  any      -> seluruh perangkat keyboard/wedge yang terdeteksi
        if (config.deviceMode === 'selected' || config.deviceMode === 'any') {
            node.deviceMode = config.deviceMode;
        } else {
            node.deviceMode = 'auto';
        }

        if (typeof config.devicePath === 'string') {
            node.devicePath = config.devicePath.trim();
        } else {
            node.devicePath = '';
        }

        // Atur nilai debounce waktu pembacaan kartu (default 1000 ms)
        let parsedDebounce = parseInt(config.debounce, 10);
        if (isNaN(parsedDebounce)) {
            node.debounce = 1000;
        } else if (parsedDebounce < 100) {
            node.debounce = 100;
        } else {
            node.debounce = parsedDebounce;
        }

        // Parse VID/PID (mendukung heksadesimal, desimal, maupun angka)
        let targetVid = parseUsbId(config.vid, DEFAULT_VID);
        if (targetVid === null) {
            node.warn('Format Vendor ID (VID) tidak valid: "' + config.vid + '". Menggunakan default 0xFFFF.');
            targetVid = DEFAULT_VID;
        }

        let targetPid = parseUsbId(config.pid, DEFAULT_PID);
        if (targetPid === null) {
            node.warn('Format Product ID (PID) tidak valid: "' + config.pid + '". Menggunakan default 0x0035.');
            targetPid = DEFAULT_PID;
        }

        // Variabel state koneksi dan pembacaan
        let resetStatusTimer = null;
        let isClosing = false;
        let rawBackendHandle = null;
        let rawConnected = false;
        let rawDeviceName = '';
        let rawDevicePath = '';

        let lastScannedUid = '';
        let lastScannedTime = 0;

        // Status ringkas untuk perangkat yang sedang terhubung
        function connectedStatusText() {
            let rawName = 'Raw Input';
            if (rawDeviceName) {
                rawName = rawDeviceName;
            }
            if (rawName.length > 25) {
                rawName = rawName.substring(0, 24) + '...';
            }
            return 'Terhubung: ' + rawName;
        }

        // Fungsi memperbarui status badge node di UI Node-RED
        function updateStatus(fillColor, shapeType, statusText) {
            node.status({
                fill: fillColor,
                shape: shapeType,
                text: statusText
            });
        }

        // Fungsi mengirimkan hasil pembacaan RFID / Barcode ke output Node-RED
        function emitCardRead(cardUid, deviceInfo) {
            if (isClosing) {
                return;
            }

            let cleanedUid = cardUid.trim();
            if (cleanedUid.length === 0) {
                return;
            }

            let currentTime = Date.now();

            // Cegah pembacaan ganda untuk UID yang sama dalam jangka waktu debounce
            if (cleanedUid === lastScannedUid && (currentTime - lastScannedTime) < node.debounce) {
                return;
            }

            lastScannedUid = cleanedUid;
            lastScannedTime = currentTime;

            // Format payload JSON bersih: timestamp dan uuid
            let msg = {
                payload: {
                    timestamp: new Date().toISOString(),
                    uuid: cleanedUid
                }
            };

            // Kirim pesan ke node output
            node.send(msg);

            // Tampilkan UID di badge status Node-RED selama 2 detik
            updateStatus('green', 'dot', 'Kartu: ' + cleanedUid);

            if (resetStatusTimer !== null) {
                clearTimeout(resetStatusTimer);
            }

            resetStatusTimer = setTimeout(function () {
                resetStatusTimer = null;
                if (rawConnected && !isClosing) {
                    updateStatus('green', 'dot', connectedStatusText());
                }
            }, 2000);
        }

        // Memulai listener Raw Input Windows (prinsip penyadapan keyboard-wedge)
        function startRawInput() {
            const helperExe = rawInputBackend.findRawInputBridge(RAW_INPUT_HELPER);
            if (!helperExe || !fs.existsSync(helperExe)) {
                node.error('Helper Raw Input tidak ditemukan.');
                updateStatus('red', 'ring', 'Helper belum dibangun');
                return;
            }

            if (node.deviceMode === 'selected' && !node.devicePath) {
                rawConnected = false;
                updateStatus('red', 'ring', 'Pilih perangkat dulu');
                return;
            }

            updateStatus('yellow', 'ring', 'Menghubungkan...');

            rawBackendHandle = rawInputBackend.start({
                helperPath: helperExe,
                parentPid: process.pid,
                deviceMode: node.deviceMode,
                devicePath: node.devicePath,
                vid: targetVid,
                pid: targetPid,

                onReady: function (message) {
                    if (isClosing) {
                        return;
                    }

                    if (message && message.device) {
                        if (message.device.displayName) {
                            rawDeviceName = message.device.displayName;
                        } else if (message.device.name) {
                            rawDeviceName = message.device.name;
                        } else {
                            rawDeviceName = 'Raw Input';
                        }

                        if (message.device.path) {
                            rawDevicePath = message.device.path;
                        }
                    }
                },

                onStatus: function (state, message) {
                    if (isClosing) {
                        return;
                    }

                    if (state === 'connected') {
                        rawConnected = true;

                        if (message && message.device) {
                            if (message.device.displayName) {
                                rawDeviceName = message.device.displayName;
                            } else if (message.device.name) {
                                rawDeviceName = message.device.name;
                            }

                            if (message.device.path) {
                                rawDevicePath = message.device.path;
                            }
                        }

                        updateStatus('green', 'dot', connectedStatusText());
                        return;
                    }

                    let wasConnected = rawConnected;
                    rawConnected = false;

                    if (wasConnected) {
                        updateStatus('red', 'ring', 'Perangkat terputus');
                    } else {
                        updateStatus('yellow', 'ring', 'Menunggu reader...');
                    }
                },

                onScan: function (scan) {
                    if (isClosing) {
                        return;
                    }

                    let info = {};
                    if (scan.device) {
                        info = scan.device;
                    }

                    rawConnected = true;

                    if (info.path) {
                        rawDevicePath = info.path;
                    }
                    if (info.displayName) {
                        rawDeviceName = info.displayName;
                    } else if (info.product) {
                        rawDeviceName = info.product;
                    }

                    let prodName = rawDeviceName;
                    if (info.displayName) {
                        prodName = info.displayName;
                    } else if (info.product) {
                        prodName = info.product;
                    }

                    let finalPath = rawDevicePath;
                    if (info.path) {
                        finalPath = info.path;
                    }

                    emitCardRead(scan.uid, {
                        vendorId: info.vendorId,
                        productId: info.productId,
                        product: prodName,
                        path: finalPath
                    });
                },

                onLog: function (level, message) {
                    if (isClosing || !message) {
                        return;
                    }

                    if (level === 'error') {
                        node.warn(message);
                    } else if (level === 'debug') {
                        if (typeof node.debug === 'function') {
                            node.debug(message);
                        }
                    } else if (typeof node.log === 'function') {
                        node.log(message);
                    }
                }
            });
        }

        // Jalankan listener saat node aktif
        startRawInput();

        // Handler saat node dinonaktifkan atau di-deploy ulang
        node.on('close', function (done) {
            isClosing = true;

            if (resetStatusTimer !== null) {
                clearTimeout(resetStatusTimer);
                resetStatusTimer = null;
            }

            if (rawBackendHandle) {
                let handle = rawBackendHandle;
                rawBackendHandle = null;
                rawConnected = false;
                updateStatus('grey', 'ring', 'Nonaktif');
                handle.close(done);
            } else {
                updateStatus('grey', 'ring', 'Nonaktif');
                done();
            }
        });
    }

    RED.nodes.registerType('usb-rfid', UsbRfidNode);
};
