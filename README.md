# @ismaillowkey/node-red-contrib-usbrfid-barcode

[English](#-english) | [Bahasa Indonesia](#-bahasa-indonesia)

---

# 🇬🇧 English

A custom Node-RED node to capture USB RFID / IC Card (125kHz EM-ID / 13.56MHz Mifare) and USB Barcode Scanner inputs operating in **HID Keyboard-Wedge** mode on Windows operating systems.

This node leverages the **Windows Raw Input API (`WM_INPUT` + `RIDEV_INPUTSINK`)** to intercept card UID strings in the background without requiring window focus, completely bypassing Windows HID security restrictions (**`Access is denied / 0x5`**).

---

## 📸 Editor Interface (Dual-Language & Visual Reader Preview)

The node appears in the Node-RED palette as **`usb rfid/keyboard`** under the **input** category. The configuration dialog (double-click) features:
- **Physical USB RFID Reader Image Preview** displayed directly beneath the device combobox.
- **Dual-Language Interface**: Every label, prompt, and tip is available in both English and Bahasa Indonesia.

---

## 🚀 Key Features

1. **Windows Raw Input Sniffing (`WM_INPUT` + `RIDEV_INPUTSINK`):**
   Captures keystrokes at the hardware device driver level without acquiring exclusive handles via `ReadFile()`. Immune to Windows OS security locking (`Access is denied / 0x5`).
2. **Background Listening (No Window Focus Required):**
   RFID cards and barcodes are captured even when Node-RED, the browser, or the desktop window is minimized or not active.
3. **Zero External Runtime Dependencies:**
   Completely standalone. Does not depend on `node-hid` or third-party binary addons. No C++ compiler or `node-gyp` needed during installation.
4. **Automatic Reconnection & Watchdog:**
   The bridge process is continuously monitored. If the USB cable is unplugged and reconnected, it automatically reconnects within 3 seconds.
5. **Debounce Protection:**
   Prevents accidental multiple scans (*double scanning*) of the same card UID within a configurable time window (in milliseconds, default `1000 ms`).
6. **Clean JSON Payload Output:**
   Emits a clean and standardized JSON payload containing an ISO-8601 UTC timestamp and the scanned UID:
   ```json
   {
     "payload": {
       "timestamp": "2026-10-21T13:00:00.000Z",
       "uuid": "0008546414"
     }
   }
   ```
7. **Real-Time Visual Status Badges:**
   - 🟢 **Green (dot)**: `Connected` / `Card: [UID]`
   - 🟡 **Yellow (ring)**: `Connecting...` / `Waiting for reader...`
   - 🔴 **Red (ring)**: `Disconnected` / `Select device first`
   - ⚪ **Grey (ring)**: `Inactive`

---

## 📋 Supported Devices

- **Default Reader:** USB RFID / IC Card Readers with Vendor ID `0xFFFF` and Product ID `0x0035` (e.g. SYC ID Reader / USB IC Card Reader 10-digit).
- **All Keyboard-Wedge Devices:** Supports any USB RFID reader (125kHz EM4100/TK4100/T5577, 13.56MHz Mifare) and USB barcode scanners that emulate keyboard keystrokes.
- **Flexible Modes:**
  - *Manual (VID & PID)*: Enter target Vendor ID and Product ID directly.
  - *Select device*: Choose from an auto-detected list of plugged-in keyboard devices.
  - *All devices*: Listen to any connected keyboard or barcode reader.

---

## ⚠️ Important Requirement: Windows Foreground Execution (Session 1)

> [!IMPORTANT]
> **Node-RED MUST be executed in the user's interactive desktop session (Session 1), NOT as a background Windows Service (Session 0).**
>
> **Technical Reason:** Windows Session 0 Isolation blocks all physical keyboard hardware input events from reaching Session 0 services for security reasons. Always start Node-RED from the user terminal (`node-red` or `npm start`).

---

## 📦 Installation in Node-RED

### Option 1: Via User Directory

Open CMD or PowerShell:

```bash
# 1. Navigate to the Node-RED user directory
cd %USERPROFILE%\.node-red

# 2. Install the package from your local folder
npm install "d:\YOURFOLDER\node-red-usb-rfid"

# 3. Start Node-RED
node-red
```


## 🛠️ Usage in Node-RED Flow

1. Open your browser and navigate to the Node-RED editor (`http://localhost:1880`).
2. Locate the node named **`usb rfid/keyboard`** under the **input** category in the left palette.
3. Drag the node onto the canvas flow.
4. Double-click the node to open the configuration modal:
   - Select mode: **Manual (VID & PID)** (default `0xFFFF` / `0x0035`) or **Select device** (click **Refresh** and select from the dropdown).
   - Set the **Debounce (ms)** duration (default `1000` ms).
   - Click **Done**.
5. Connect the node's output to a **`debug`** node.
6. Click the **Deploy** button.
7. Tap an RFID card on the reader. The card's UID and timestamp will appear instantly in the Debug sidebar!

---

## 🧪 Testing & Helper Compilation

### Automated Unit Tests (18 Test Suites)

Verify all node and bridge logic using Node.js's built-in test runner:

```bash
npm test
```

### Rebuilding the C# Helper (`RawInputBridge.exe`)

The compiled executable is already provided in `bin/win/RawInputBridge.exe`. To recompile from source:

```bash
npm run build:helper
```

---

## 📄 License & Author

- **Author:** **Paduka Raja.ST**
- **License:** [MIT License](https://opensource.org/licenses/MIT)

---
---

# 🇮🇩 Bahasa Indonesia

Palet kustom Node-RED untuk membaca kartu RFID / IC Card (125kHz EM-ID / 13.56MHz Mifare) serta Barcode Scanner USB berbasis **HID Keyboard-Wedge** secara langsung pada sistem operasi Windows.

Node ini menggunakan **Windows Raw Input API (`WM_INPUT` + `RIDEV_INPUTSINK`)** untuk menyadap nomor kartu secara andal di latar belakang, tanpa memerlukan fokus jendela, dan **100% bebas dari pemblokiran keamanan Windows (`Access is denied / 0x5`)**.

---

## 📸 Antarmuka Editor (Dual-Language & Preview Reader)

Node ini tampil di palet Node-RED dengan nama **`usb rfid/keyboard`** (kategori **input**). Dialog konfigurasi (klik ganda) dilengkapi dengan:
- **Foto Fisik USB Reader (IC Reader)** yang langsung ditampilkan di bawah combobox pilihan perangkat.
- **Dukungan Dua Bahasa (Dual-Language)**: Bahasa Indonesia dan English pada seluruh label, petunjuk, dan opsi pengaturan.

---

## 🚀 Fitur Utama

1. **Windows Raw Input Sniffing (`WM_INPUT` + `RIDEV_INPUTSINK`):**
   Menyadap input keyboard-wedge tanpa membuka handle eksklusif `ReadFile()`, sehingga terbebas dari error `Access is denied (0x5)` khas driver HID Windows.
2. **Tanpa Perlu Fokus Jendela (Background Listening):**
   Kartu tetap terbaca meskipun browser Node-RED, aplikasi lain, atau desktop sedang tidak aktif/fokus.
3. **Zero External Runtime Dependencies:**
   Tidak menggunakan `node-hid` atau modul binary pihak ketiga lainnya. Instalasi cepat tanpa membutuhkan compiler C++ / `node-gyp`.
4. **Auto-Reconnect & Watchdog Otomatis:**
   Proses helper dipantau secara berkala. Jika koneksi terputus atau kabel USB reader dicabut-pasang, listener otomatis tersambung kembali dalam hitungan 3 detik.
5. **Debounce Protection:**
   Mencegah pemindaian ganda (*double scan*) untuk UID kartu yang sama dalam selang waktu tertentu (dapat diatur dalam milidetik, default `1000 ms`).
6. **Output Payload JSON Bersih & Konsisten:**
   Mengeluarkan data siap pakai berisi stempel waktu ISO (`timestamp`) dan nomor kartu (`uuid`):
   ```json
   {
     "payload": {
       "timestamp": "2026-10-21T13:00:00.000Z",
       "uuid": "0008546414"
     }
   }
   ```
7. **Status Visual Real-Time:**
   Indikator status berwarna pada canvas Node-RED:
   - 🟢 **Hijau (dot)**: `Terhubung` / `Kartu: [UID]`
   - 🟡 **Kuning (ring)**: `Menghubungkan...` / `Menunggu reader...`
   - 🔴 **Merah (ring)**: `Perangkat terputus` / `Pilih perangkat dulu`
   - ⚪ **Abu-abu (ring)**: `Nonaktif`

---

## 📋 Perangkat yang Didukung

- **Default Reader:** USB RFID / IC Card Reader dengan Vendor ID `0xFFFF` dan Product ID `0x0035` (contoh: SYC ID Reader / USB IC Reader 10-digit).
- **Semua Perangkat Keyboard-Wedge:** Mendukung seluruh USB RFID Reader frekuensi 125kHz, 13.56MHz Mifare, serta Barcode Scanner USB yang bekerja layaknya ketikan keyboard.
- **Pilihan Fleksibel:**
  - *Manual (VID & PID)*: Masukkan Vendor ID dan Product ID secara manual.
  - *Pilih perangkat tertentu*: Pilih reader dari daftar hasil pemindaian sistem.
  - *Semua perangkat keyboard*: Menerima input dari seluruh keyboard/scanner yang aktif.

---

## ⚠️ Catatan Penting: Eksekusi Foreground (Session 1)

> [!IMPORTANT]
> **Node-RED WAJIB dijalankan pada sesi desktop pengguna (Session 1), BUKAN sebagai Windows Service latar belakang (Session 0).**
>
> **Alasan Teknis:** Fitur keamanan Windows (*Session 0 Isolation*) secara otomatis mengisolasi dan memblokir seluruh penangkapan input keyboard fisik dari desktop pengguna (Session 1) ke sesi service latar belakang (Session 0). Jalankan Node-RED melalui terminal CMD / PowerShell pengguna (`node-red` atau `npm start`).

---

## 📦 Pemasangan ke Node-RED

### Metode 1: Instalasi via Direktori Pengguna Node-RED

Buka terminal CMD atau PowerShell:

```bash
# 1. Masuk ke folder pengguna Node-RED
cd %USERPROFILE%\.node-red

# 2. Pasang paket dari direktori proyek
npm install "d:\YOURFOLDER\node-red-usb-rfid"

# 3. Jalankan kembali Node-RED
node-red
```

---

## 🛠️ Cara Penggunaan di Flow Node-RED

1. Buka browser dan akses antarmuka Node-RED (`http://localhost:1880`).
2. Cari node bernama **`usb rfid/keyboard`** pada kategori **input** di palet kiri.
3. Tarik node ke canvas flow.
4. Klik dua kali pada node untuk membuka dialog konfigurasi:
   - Pilih mode: **Manual (VID & PID)** (default `0xFFFF` / `0x0035`) atau **Pilih perangkat tertentu** dengan menekan tombol **Refresh** lalu memilih nama reader pada dropdown.
   - Atur batas **Debounce (ms)** (default `1000` ms).
   - Simpan dengan menekan tombol **Done**.
5. Sambungkan output node **`usb rfid/keyboard`** ke node **`debug`** (atur debug menampilkan `complete msg object` atau `msg.payload`).
6. Klik tombol **Deploy** di pojok kanan atas.
7. Tempelkan kartu RFID Anda ke alat pembaca. Data kartu seketika muncul di tab Debug Node-RED!

---

## 🧪 Pengujian Otomatis & Kompilasi Helper

### Menjalankan Unit Test (18 Test Suites)

Modul ini dilengkapi dengan 18 unit test otomatis bawaan Node.js tanpa membutuhkan hardware fisik:

```bash
npm test
```

### Membangun Ulang Helper C# (`RawInputBridge.exe`)

Binary helper Raw Input sudah disertakan di dalam folder `bin/win/RawInputBridge.exe`. Bila Anda ingin mengompilasi ulang helper dari kode sumber [RawInputBridge.cs](file:///d:/DATA/App%20software%20bikinan/node-red-usb-rfid/helper-src/RawInputBridge.cs):

```bash
npm run build:helper
```
*(Script ini menggunakan compiler .NET Framework bawaan Windows `csc.exe` tanpa perlu menginstal SDK tambahan).*

---

## 📄 Lisensi & Hak Cipta

- **Author:** **Paduka Raja.ST**
- **Lisensi:** [MIT License](https://opensource.org/licenses/MIT)
