'use strict';

const test = require('node:test');
const assert = require('node:assert');

const rawBackend = require('../lib/raw-input-backend');

// Simpan fungsi asli sebelum mock dipasang
const originalStart = rawBackend.start;
const originalListDevices = rawBackend.listDevices;

// ---------------------------------------------------------------------------
// Mock Node-RED Environment
// ---------------------------------------------------------------------------
const adminRoutes = {};
let NodeConstructor = null;

const RED = {
    nodes: {
        createNode: function (node, config) {
            node.id = config.id;
            node.__sent = [];
            node.__statuses = [];
            node.__warnings = [];
            node.__errors = [];
            node.__handlers = {};

            node.send = function (msg) {
                node.__sent.push(msg);
            };

            node.status = function (status) {
                node.__statuses.push(status);
            };

            node.on = function (event, handler) {
                node.__handlers[event] = handler;
            };

            node.warn = function (msg) {
                node.__warnings.push(msg);
            };

            node.error = function (err) {
                node.__errors.push(String(err));
            };

            node.log = function () {};
            node.debug = function () {};
        },
        registerType: function (type, ctor) {
            NodeConstructor = ctor;
        }
    },
    httpAdmin: {
        get: function (routePath, authMiddleware, handler) {
            adminRoutes[routePath] = handler;
        }
    },
    auth: {
        needsPermission: function () {
            return function (req, res, next) {
                if (next) {
                    next();
                }
            };
        }
    }
};

// Muat implementasi modul usb-rfid ke mock Node-RED
require('../usb-rfid.js')(RED);

// ---------------------------------------------------------------------------
// Helper Mock Backend Raw Input
// ---------------------------------------------------------------------------
class FakeBackendHandle {
    constructor(callbacks) {
        this.callbacks = callbacks;
        this.closed = false;
    }

    close(done) {
        this.closed = true;
        if (typeof done === 'function') {
            done();
        }
    }

    triggerReady(message) {
        if (typeof this.callbacks.onReady === 'function') {
            this.callbacks.onReady(message);
        }
    }

    triggerStatus(state, message) {
        if (typeof this.callbacks.onStatus === 'function') {
            this.callbacks.onStatus(state, message);
        }
    }

    triggerScan(scan) {
        if (typeof this.callbacks.onScan === 'function') {
            this.callbacks.onScan(scan);
        }
    }

    triggerLog(level, message) {
        if (typeof this.callbacks.onLog === 'function') {
            this.callbacks.onLog(level, message);
        }
    }
}

let lastCreatedBackend = null;
let lastStartOptions = null;
let activeNodes = [];

function setupMockBackend() {
    rawBackend.start = function (options) {
        lastStartOptions = options;
        lastCreatedBackend = new FakeBackendHandle(options);
        return lastCreatedBackend;
    };
}

function createNode(overrides) {
    assert.ok(NodeConstructor, 'node type usb-rfid harus terdaftar');

    let baseConfig = {
        id: 'n1',
        vid: '0xFFFF',
        pid: '0x0035',
        debounce: 1000,
        deviceMode: 'auto',
        devicePath: ''
    };

    let config = Object.assign(baseConfig, overrides || {});
    let node = new NodeConstructor(config);
    activeNodes.push(node);
    return node;
}

function closeNode(node) {
    if (node.__closed) {
        return;
    }
    node.__closed = true;

    let closeHandler = node.__handlers.close;
    if (typeof closeHandler === 'function') {
        closeHandler(function () {});
    }
}

function lastStatus(node) {
    if (!node.__statuses || node.__statuses.length === 0) {
        return null;
    }
    return node.__statuses[node.__statuses.length - 1];
}

function delay(ms) {
    return new Promise(function (resolve) {
        setTimeout(resolve, ms);
    });
}

test.beforeEach(function () {
    setupMockBackend();
    lastCreatedBackend = null;
    lastStartOptions = null;
});

test.afterEach(function () {
    while (activeNodes.length > 0) {
        closeNode(activeNodes.pop());
    }
    rawBackend.start = originalStart;
    rawBackend.listDevices = originalListDevices;
});

// ---------------------------------------------------------------------------
// Unit Tests
// ---------------------------------------------------------------------------

test('helper toHex memformat VID/PID secara konsisten', function () {
    assert.equal(rawBackend.toHex(0x35, 4), '0x0035');
    assert.equal(rawBackend.toHex(0xFFFF, 4), '0xFFFF');
    assert.equal(rawBackend.toHex(undefined, 4), '');
});

test('endpoint /usb-rfid/devices mengembalikan daftar perangkat', function (t, done) {
    const handler = adminRoutes['/usb-rfid/devices'];
    assert.equal(typeof handler, 'function', 'route admin harus terdaftar');

    // Mock fungsi listDevices untuk pengujian endpoint
    rawBackend.listDevices = function (helperPath, cb) {
        cb(null, [
            {
                path: '\\\\?\\HID#VID_FFFF&PID_0035&MI_00#0001',
                name: 'HID Keyboard Device',
                displayName: 'HID Keyboard Device (VID:FFFF PID:0035) [Keyboard]',
                vendorId: 0xFFFF,
                productId: 0x0035,
                keyboard: true
            }
        ]);
    };

    let mockResponse = {
        set: function () {},
        json: function (data) {
            assert.ok(data, 'response JSON harus dikembalikan');
            assert.ok(data.count > 0, 'perangkat harus terdeteksi');
            assert.ok(data.devices.length > 0);
            assert.ok(data.devices[0].path);
            assert.ok(data.devices[0].label);
            rawBackend.listDevices = originalListDevices;
            done();
        },
        status: function () {
            return {
                json: function () {
                    rawBackend.listDevices = originalListDevices;
                    done();
                }
            };
        }
    };

    handler({}, mockResponse);
});

test('mode auto menginisialisasi listener dengan VID/PID default', function () {
    let node = createNode({
        vid: '0xFFFF',
        pid: '0x0035'
    });

    assert.ok(lastCreatedBackend, 'backend raw input harus dibuat');
    assert.equal(lastStartOptions.deviceMode, 'auto');
    assert.equal(lastStartOptions.vid, 0xFFFF);
    assert.equal(lastStartOptions.pid, 0x0035);

    let currentStatus = lastStatus(node);
    assert.equal(currentStatus.fill, 'yellow');
    assert.equal(currentStatus.text, 'Menghubungkan...');
});

test('mode selected tanpa devicePath membatalkan proses dan memberi status peringatan', function () {
    let node = createNode({
        deviceMode: 'selected',
        devicePath: ''
    });

    let currentStatus = lastStatus(node);
    assert.equal(currentStatus.fill, 'red');
    assert.equal(currentStatus.text, 'Pilih perangkat dulu');
    assert.equal(lastCreatedBackend, null, 'backend tidak boleh dipanggil jika path kosong');
});

test('mode selected dengan devicePath meneruskan parameter ke backend', function () {
    let targetPath = '\\\\?\\HID#VID_FFFF&PID_0035#0001';
    let node = createNode({
        deviceMode: 'selected',
        devicePath: targetPath
    });

    assert.ok(lastCreatedBackend, 'backend raw input harus dibuat');
    assert.equal(lastStartOptions.deviceMode, 'selected');
    assert.equal(lastStartOptions.devicePath, targetPath);
});

test('mode any meneruskan parameter deviceMode any ke backend', function () {
    let node = createNode({
        deviceMode: 'any'
    });

    assert.ok(lastCreatedBackend, 'backend raw input harus dibuat');
    assert.equal(lastStartOptions.deviceMode, 'any');
});

test('status node berubah sesuai event backend (connected, disconnected)', function () {
    let node = createNode();

    // Simulasikan event connected dari backend
    lastCreatedBackend.triggerStatus('connected', {
        device: {
            displayName: 'SYC ID Reader (VID:FFFF PID:0035) [Keyboard]',
            path: 'p-syc'
        }
    });

    let statusConn = lastStatus(node);
    assert.equal(statusConn.fill, 'green');
    assert.equal(statusConn.shape, 'dot');
    assert.ok(statusConn.text.indexOf('Terhubung') !== -1);

    // Simulasikan event disconnected dari backend
    lastCreatedBackend.triggerStatus('disconnected', {});

    let statusDisconn = lastStatus(node);
    assert.equal(statusDisconn.fill, 'red');
    assert.equal(statusDisconn.shape, 'ring');
    assert.equal(statusDisconn.text, 'Perangkat terputus');
});

test('pembacaan kartu (onScan) mengirim pesan msg ke output Node-RED', function () {
    let node = createNode();

    lastCreatedBackend.triggerScan({
        uid: '0008546414',
        source: 'keyboard',
        device: {
            vendorId: 0xFFFF,
            productId: 0x0035,
            product: 'SYC ID Reader',
            path: 'device-path-1'
        }
    });

    assert.equal(node.__sent.length, 1, 'harus mengirim 1 pesan');
    let message = node.__sent[0];

    assert.equal(typeof message.payload, 'object', 'payload harus berupa objek JSON');
    assert.equal(message.payload.uuid, '0008546414');
    assert.ok(message.payload.timestamp, 'timestamp harus ada');

    let currentStatus = lastStatus(node);
    assert.equal(currentStatus.fill, 'green');
    assert.equal(currentStatus.text, 'Kartu: 0008546414');
});

test('debounce menyaring pemindaian UID yang sama secara berturut-turut', function () {
    let node = createNode({ debounce: 500 });

    // Pemindaian pertama
    lastCreatedBackend.triggerScan({
        uid: '123456',
        source: 'keyboard',
        device: { vendorId: 0xFFFF, productId: 0x0035 }
    });

    // Pemindaian kedua dengan UID sama seketika
    lastCreatedBackend.triggerScan({
        uid: '123456',
        source: 'keyboard',
        device: { vendorId: 0xFFFF, productId: 0x0035 }
    });

    assert.equal(node.__sent.length, 1, 'pemindaian kedua harus disaring oleh debounce');
});

test('debounce mengizinkan pemindaian UID yang sama setelah jeda debounce habis', async function () {
    let node = createNode({ debounce: 150 });

    // Pemindaian pertama
    lastCreatedBackend.triggerScan({
        uid: '999999',
        source: 'keyboard',
        device: { vendorId: 0xFFFF, productId: 0x0035 }
    });

    assert.equal(node.__sent.length, 1);

    // Tunggu melewati waktu debounce
    await delay(180);

    // Pemindaian kedua setelah jeda
    lastCreatedBackend.triggerScan({
        uid: '999999',
        source: 'keyboard',
        device: { vendorId: 0xFFFF, productId: 0x0035 }
    });

    assert.equal(node.__sent.length, 2, 'pemindaian kedua harus diizinkan setelah jeda');
});

test('pemindaian UID yang berbeda langsung diproses tanpa tertahan debounce', function () {
    let node = createNode({ debounce: 1000 });

    lastCreatedBackend.triggerScan({
        uid: 'UID-A',
        source: 'keyboard',
        device: { vendorId: 0xFFFF, productId: 0x0035 }
    });

    lastCreatedBackend.triggerScan({
        uid: 'UID-B',
        source: 'keyboard',
        device: { vendorId: 0xFFFF, productId: 0x0035 }
    });

    assert.equal(node.__sent.length, 2, 'dua kartu yang berbeda harus segera terkirim keduanya');
    assert.equal(node.__sent[0].payload.uuid, 'UID-A');
    assert.equal(node.__sent[1].payload.uuid, 'UID-B');
});

test('format VID/PID tidak valid memakai default dan mencatat warning', function () {
    let node = createNode({
        vid: 'bukan-hex-atau-desimal',
        pid: '99999999' // melebihi batas 0xFFFF
    });

    assert.ok(node.__warnings.length >= 2, 'harus mencatat dua pesan peringatan');
    assert.equal(lastStartOptions.vid, 0xFFFF);
    assert.equal(lastStartOptions.pid, 0x0035);
});

test('penutupan node (close event) memanggil penutupan backend dengan aman', function () {
    let node = createNode();
    assert.ok(lastCreatedBackend);
    assert.equal(lastCreatedBackend.closed, false);

    closeNode(node);

    assert.equal(lastCreatedBackend.closed, true);
    let finalStatus = lastStatus(node);
    assert.equal(finalStatus.fill, 'grey');
    assert.equal(finalStatus.text, 'Nonaktif');
});
