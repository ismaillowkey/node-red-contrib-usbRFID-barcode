'use strict';

// Backend Raw Input (Windows) untuk node-red-contrib-usb-rfid.
// Menggunakan arsitektur penyadap Raw Input dari helper RawInputBridge.exe
// dengan sistem auto-reconnect otomatis dan pembacaan konfigurasi laststate.conf.

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
// Interval waktu reconnect otomatis (3 detik)
const RECONNECT_INTERVAL_MS = 3000;
const RESTART_DELAY = 3000;
const HEARTBEAT_TIMEOUT = 20000;
const STOP_TIMEOUT = 1500;
const MAX_LINE_LENGTH = 64 * 1024;
const CONFIG_FILE_NAME = 'laststate.conf';

// Mengubah nilai angka VID/PID menjadi teks heksadesimal 4 digit (contoh: 0x0035)
function toHex(value, pad) {
    if (typeof value !== 'number' || !isFinite(value)) {
        return '';
    }

    let width = 4;
    if (typeof pad === 'number' && pad > 0) {
        width = pad;
    }

    let hex = Math.abs(Math.trunc(value)).toString(16).toUpperCase();
    while (hex.length < width) {
        hex = '0' + hex;
    }

    return '0x' + hex;
}

function toHex4(value) {
    return toHex(value, 4);
}

/**
 * Membaca ID perangkat terakhir dari file konfigurasi laststate.conf
 */
function readLastStateConfig(filePath) {
    if (!filePath) {
        return null;
    }

    if (!fs.existsSync(filePath)) {
        return null;
    }

    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i].trim();
            if (line.length === 0) {
                continue;
            }

            // Lewati baris komentar
            if (line.startsWith('#') || line.startsWith(';') || line.startsWith('//')) {
                continue;
            }

            // Periksa format key-value jika ada
            if (line.toLowerCase().startsWith('deviceid=')) {
                return line.substring('deviceid='.length).trim();
            }

            if (line.toLowerCase().startsWith('devicepath=')) {
                return line.substring('devicepath='.length).trim();
            }

            if (line.toLowerCase().startsWith('id=')) {
                return line.substring('id='.length).trim();
            }

            // Format baris teks ID langsung
            return line;
        }
    } catch (err) {
        // Gagal membaca file konfigurasi
    }

    return null;
}

/**
 * Mencari file konfigurasi laststate.conf di berbagai lokasi kandidat
 */
function findLastStateConfig() {
    const candidatePaths = [
        path.resolve(process.cwd(), CONFIG_FILE_NAME),
        path.resolve(__dirname, '..', CONFIG_FILE_NAME),
        path.resolve(__dirname, CONFIG_FILE_NAME),
        path.resolve(__dirname, '..', '..', 'WinformUSBRFID', CONFIG_FILE_NAME)
    ];

    for (let i = 0; i < candidatePaths.length; i++) {
        let candidate = candidatePaths[i];
        if (fs.existsSync(candidate)) {
            let id = readLastStateConfig(candidate);
            if (id && id.length > 0) {
                return id;
            }
        }
    }

    return null;
}

/**
 * Mencari lokasi file executable RawInputBridge.exe
 */
function findRawInputBridge(configuredPath) {
    if (configuredPath && fs.existsSync(configuredPath)) {
        return configuredPath;
    }

    const candidatePaths = [
        path.resolve(__dirname, '..', 'bin', 'win', 'RawInputBridge.exe'),
        path.resolve(__dirname, '..', 'bin', 'RawInputBridge.exe'),
        path.resolve(__dirname, 'bin', 'win', 'RawInputBridge.exe'),
        path.resolve(__dirname, 'bin', 'RawInputBridge.exe'),
        path.resolve(__dirname, 'RawInputBridge.exe'),
        path.resolve(__dirname, '..', '..', 'WinformUSBRFID', 'bin', 'RawInputBridge.exe'),
        path.resolve(process.cwd(), 'bin', 'win', 'RawInputBridge.exe'),
        path.resolve(process.cwd(), 'bin', 'RawInputBridge.exe')
    ];

    for (let i = 0; i < candidatePaths.length; i++) {
        let p = candidatePaths[i];
        if (fs.existsSync(p)) {
            return p;
        }
    }

    return null;
}

/**
 * Menyusun argumen helper dari konfigurasi node.
 */
function buildArguments(options) {
    let config = options;
    if (!config) {
        config = {};
    }

    const args = ['--listen', '--idle=250'];

    if (config.parentPid) {
        args.push('--parent-pid=' + config.parentPid);
    }

    if (config.debug) {
        args.push('--debug');
    }

    if (config.deviceMode === 'any') {
        args.push('--any');
        return args;
    }

    // Tentukan target path perangkat
    let targetPath = '';
    if (config.deviceMode === 'selected' && config.devicePath) {
        targetPath = config.devicePath.trim();
    } else if (!config.devicePath) {
        // Coba cari dari laststate.conf bila tidak diisi spesifik
        let savedPath = findLastStateConfig();
        if (savedPath && savedPath.length > 0) {
            targetPath = savedPath;
        }
    }

    if (targetPath.length > 0) {
        // Jika path perangkat merujuk ke antarmuka non-keyboard (misal MI_01),
        // otomatis arahkan ke MI_00 (antarmuka keyboard) agar penangkap Raw Input berfungsi
        if (targetPath.indexOf('MI_01') !== -1) {
            targetPath = targetPath.replace(/MI_01/g, 'MI_00');
        }
        if (targetPath.indexOf('{4d1e55b2-f16f-11cf-88cb-001111000030}') !== -1) {
            targetPath = targetPath.replace(/\{4d1e55b2-f16f-11cf-88cb-001111000030\}/g, '{884b96c3-56ef-11d1-bc8c-00a0c91405dd}');
        }
        if (targetPath.endsWith('\\KBD')) {
            targetPath = targetPath.substring(0, targetPath.length - 4);
        }

        args.push('--path=' + targetPath);
    }

    if (typeof config.vid === 'number' && isFinite(config.vid)) {
        args.push('--vid=' + toHex4(config.vid));
    }

    if (typeof config.pid === 'number' && isFinite(config.pid)) {
        args.push('--pid=' + toHex4(config.pid));
    }

    return args;
}

/**
 * Parsing aman untuk satu baris JSON dari helper.
 */
function parseLine(line) {
    if (typeof line !== 'string') {
        return null;
    }

    const text = line.trim();
    if (text.length === 0) {
        return null;
    }

    try {
        const value = JSON.parse(text);
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            return value;
        }
        return null;
    } catch (err) {
        return null;
    }
}

/**
 * Menyeragamkan data perangkat Raw Input dengan data node-hid untuk editor.
 */
function normalizeDevice(device) {
    let dev = device;
    if (!dev) {
        dev = {};
    }

    let vendorId = null;
    if (typeof dev.vendorId === 'number' && isFinite(dev.vendorId)) {
        vendorId = dev.vendorId;
    }

    let productId = null;
    if (typeof dev.productId === 'number' && isFinite(dev.productId)) {
        productId = dev.productId;
    }

    let product = '';
    if (dev.name) {
        product = dev.name;
    } else if (dev.product) {
        product = dev.product;
    }

    let label = 'Raw Input Device';
    if (dev.displayName) {
        label = dev.displayName;
    } else if (product.length > 0) {
        label = product;
    }

    if (!dev.displayName && vendorId !== null && productId !== null) {
        label += ' [' + toHex4(vendorId) + ':' + toHex4(productId) + ']';
    }

    let isKeyboard = false;
    if (dev.keyboard === true) {
        isKeyboard = true;
    }

    let typeName = '';
    if (dev.typeName) {
        typeName = dev.typeName;
    }

    return {
        path: dev.path || '',
        label: label,
        vendorId: vendorId,
        productId: productId,
        vendorIdHex: toHex4(vendorId),
        productIdHex: toHex4(productId),
        product: product,
        manufacturer: '',
        serialNumber: '',
        interface: null,
        usagePage: null,
        usage: null,
        type: typeName,
        keyboard: isKeyboard,
        source: 'rawinput'
    };
}

/**
 * Menyeragamkan data scan RFID untuk diteruskan ke node.
 */
function normalizeScan(message) {
    if (!message || typeof message.uid !== 'string') {
        return null;
    }

    const uid = message.uid.trim();
    if (uid.length === 0) {
        return null;
    }

    let src = 'keyboard';
    if (message.source) {
        src = message.source;
    }

    let timeStr = new Date().toISOString();
    if (message.timestamp) {
        timeStr = message.timestamp;
    }

    return {
        uid: uid,
        source: src,
        timestamp: timeStr,
        device: normalizeDevice(message.device)
    };
}

/**
 * Memulai listener bridge penyadap USB RFID dengan logika auto-reconnect
 */
function start(options) {
    let config = options;
    if (!config) {
        config = {};
    }

    let spawnFn = spawn;
    if (config.spawn) {
        spawnFn = config.spawn;
    }

    let isShuttingDown = false;
    let currentBridgeProcess = null;
    let reconnectTimer = null;
    let retryStartTimer = null;
    let isCurrentlyConnected = false;
    let lineReader = null;

    function log(level, message) {
        if (typeof config.onLog === 'function') {
            config.onLog(level, message);
        }
    }

    function reportStatus(state, payload) {
        let data = payload;
        if (!data) {
            data = {};
        }

        if (typeof config.onStatus === 'function') {
            config.onStatus(state, data);
        }
    }

    function handleMessage(payload) {
        if (!payload || typeof payload.type !== 'string') {
            return;
        }

        if (payload.type === 'scan') {
            const scan = normalizeScan(payload);
            if (scan && typeof config.onScan === 'function') {
                config.onScan(scan);
            }
        } else if (payload.type === 'status') {
            if (payload.state === 'connected') {
                isCurrentlyConnected = true;

                // Hentikan timer log reconnect berkala bila sudah terhubung
                if (reconnectTimer !== null) {
                    clearInterval(reconnectTimer);
                    reconnectTimer = null;
                }

                reportStatus('connected', payload);
            } else if (payload.state === 'disconnected') {
                isCurrentlyConnected = false;
                reportStatus('disconnected', payload);

                // Jalankan timer berkala info reconnect
                if (reconnectTimer === null) {
                    reconnectTimer = setInterval(function () {
                        if (!isCurrentlyConnected && !isShuttingDown) {
                            log('info', 'Reconnecting ke USB RFID... (menunggu perangkat terhubung)');
                        }
                    }, RECONNECT_INTERVAL_MS);

                    if (reconnectTimer.unref) {
                        reconnectTimer.unref();
                    }
                }
            }
        } else if (payload.type === 'ready') {
            if (typeof config.onReady === 'function') {
                config.onReady(payload);
            }
        } else if (payload.type === 'error') {
            log('error', payload.message || 'Kesalahan helper Raw Input.');
        } else if (payload.type === 'info') {
            log('info', payload.message || '');
        } else if (payload.type === 'debug') {
            log('debug', JSON.stringify(payload));
        }
    }

    function startBridge() {
        if (isShuttingDown) {
            return;
        }

        // Bersihkan timer retry start jika ada
        if (retryStartTimer !== null) {
            clearTimeout(retryStartTimer);
            retryStartTimer = null;
        }

        // Cari lokasi binary bridge RawInputBridge.exe
        const bridgeExe = findRawInputBridge(config.helperPath);
        if (!bridgeExe) {
            log('error', 'RawInputBridge.exe tidak ditemukan. Menunggu kompilasi helper...');
            reportStatus('disconnected', { message: 'RawInputBridge.exe tidak ditemukan' });
            retryStartTimer = setTimeout(startBridge, RECONNECT_INTERVAL_MS);
            if (retryStartTimer.unref) {
                retryStartTimer.unref();
            }
            return;
        }

        const bridgeArgs = buildArguments(config);

        let bridgeProcess = null;
        try {
            bridgeProcess = spawnFn(bridgeExe, bridgeArgs, {
                windowsHide: true,
                stdio: ['pipe', 'pipe', 'pipe']
            });
        } catch (spawnErr) {
            log('error', 'Gagal menjalankan bridge: ' + spawnErr.message);
            reportStatus('disconnected', { message: 'Gagal menjalankan bridge' });
            retryStartTimer = setTimeout(startBridge, RECONNECT_INTERVAL_MS);
            if (retryStartTimer.unref) {
                retryStartTimer.unref();
            }
            return;
        }

        currentBridgeProcess = bridgeProcess;

        if (bridgeProcess.stdout) {
            bridgeProcess.stdout.setEncoding('utf8');
            lineReader = readline.createInterface({
                input: bridgeProcess.stdout,
                terminal: false
            });

            lineReader.on('line', function (line) {
                if (typeof line !== 'string' || line.length > MAX_LINE_LENGTH) {
                    return;
                }

                const payload = parseLine(line);
                if (payload) {
                    handleMessage(payload);
                }
            });
        }

        if (bridgeProcess.stderr) {
            bridgeProcess.stderr.setEncoding('utf8');
            bridgeProcess.stderr.on('data', function (data) {
                const text = String(data || '').trim();
                if (text.length > 0) {
                    log('error', 'Bridge stderr: ' + text);
                }
            });
        }

        bridgeProcess.on('error', function (err) {
            log('error', 'Bridge error: ' + err.message);
            if (currentBridgeProcess === bridgeProcess) {
                reportStatus('disconnected', { message: err.message });
            }
        });

        bridgeProcess.on('exit', function (code, signal) {
            if (currentBridgeProcess !== bridgeProcess) {
                return;
            }

            currentBridgeProcess = null;
            isCurrentlyConnected = false;

            if (lineReader) {
                lineReader.close();
                lineReader = null;
            }

            if (reconnectTimer !== null) {
                clearInterval(reconnectTimer);
                reconnectTimer = null;
            }

            if (!isShuttingDown) {
                let detail = 'Koneksi terputus';
                if (code !== null && code !== undefined) {
                    detail += ' (kode ' + code + ')';
                }
                log('info', detail + '. Reconnecting dalam ' + (RECONNECT_INTERVAL_MS / 1000) + ' detik...');
                reportStatus('disconnected', { message: detail });

                retryStartTimer = setTimeout(startBridge, RECONNECT_INTERVAL_MS);
                if (retryStartTimer.unref) {
                    retryStartTimer.unref();
                }
            }
        });
    }

    startBridge();

    return {
        isRunning: function () {
            if (currentBridgeProcess !== null && !isShuttingDown) {
                return true;
            }
            return false;
        },

        close: function (done) {
            isShuttingDown = true;

            if (retryStartTimer !== null) {
                clearTimeout(retryStartTimer);
                retryStartTimer = null;
            }

            if (reconnectTimer !== null) {
                clearInterval(reconnectTimer);
                reconnectTimer = null;
            }

            if (lineReader) {
                lineReader.close();
                lineReader = null;
            }

            const proc = currentBridgeProcess;
            currentBridgeProcess = null;
            isCurrentlyConnected = false;

            if (!proc) {
                if (typeof done === 'function') {
                    done();
                }
                return;
            }

            let finished = false;
            let killTimer = null;

            function finish() {
                if (finished) {
                    return;
                }
                finished = true;

                if (killTimer !== null) {
                    clearTimeout(killTimer);
                    killTimer = null;
                }

                if (typeof done === 'function') {
                    done();
                }
            }

            proc.once('exit', finish);

            try {
                if (proc.stdin) {
                    proc.stdin.write('stop\n');
                    proc.stdin.end();
                }
            } catch (err) {
                // Abaikan kesalahan penulisan stdin
            }

            killTimer = setTimeout(function () {
                try {
                    proc.kill();
                } catch (err) {
                    // Abaikan kesalahan kill proses
                }
                finish();
            }, STOP_TIMEOUT);

            if (killTimer.unref) {
                killTimer.unref();
            }
        }
    };
}

/**
 * Mengambil daftar perangkat Raw Input lewat helper --list.
 */
function listDevices(helperPath, callback) {
    if (typeof callback !== 'function') {
        return;
    }

    const bridgeExe = findRawInputBridge(helperPath);
    if (!bridgeExe) {
        callback(new Error('Helper Raw Input tidak ditemukan: ' + (helperPath || '(kosong)')));
        return;
    }

    execFile(bridgeExe, ['--list'], {
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 2 * 1024 * 1024,
        encoding: 'utf8'
    }, function (err, stdout, stderr) {
        if (err) {
            let detail = '';
            if (stderr) {
                detail = String(stderr).trim();
            }

            let errMessage = 'Gagal membaca daftar Raw Input';
            if (detail.length > 0) {
                errMessage += ': ' + detail;
            } else {
                errMessage += ': ' + err.message;
            }

            callback(new Error(errMessage));
            return;
        }

        let data;
        try {
            data = JSON.parse(String(stdout || '').trim());
        } catch (parseErr) {
            callback(new Error('Output helper --list bukan JSON yang valid: ' + parseErr.message));
            return;
        }

        if (!data || !Array.isArray(data.devices)) {
            callback(new Error('Format daftar perangkat Raw Input tidak valid.'));
            return;
        }

        callback(null, data.devices);
    });
}

module.exports = {
    start: start,
    buildArguments: buildArguments,
    parseLine: parseLine,
    normalizeDevice: normalizeDevice,
    normalizeScan: normalizeScan,
    listDevices: listDevices,
    readLastStateConfig: readLastStateConfig,
    findLastStateConfig: findLastStateConfig,
    findRawInputBridge: findRawInputBridge,
    RESTART_DELAY: RESTART_DELAY,
    HEARTBEAT_TIMEOUT: HEARTBEAT_TIMEOUT,
    RECONNECT_INTERVAL_MS: RECONNECT_INTERVAL_MS,
    toHex: toHex
};
