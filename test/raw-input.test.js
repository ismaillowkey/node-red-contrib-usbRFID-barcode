'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');

const rawInput = require('../lib/raw-input-backend');

const HELPER_PATH = path.join(__dirname, '..', 'bin', 'win', 'RawInputBridge.exe');

function delay(ms) {
    return new Promise(function (resolve) {
        setTimeout(resolve, ms);
    });
}

class FakeChild extends EventEmitter {
    constructor() {
        super();
        this.stdout = new PassThrough();
        this.stderr = new PassThrough();
        this.stdinWrites = [];
        this.killed = false;

        const self = this;
        this.stdin = new Writable({
            write: function (chunk, encoding, callback) {
                self.stdinWrites.push(String(chunk));
                callback();
            }
        });
    }

    kill() {
        this.killed = true;
        this.emit('exit', 0, null);
    }
}

test('buildArguments menyusun filter VID/PID, path, any, dan parent pid', function () {
    const auto = rawInput.buildArguments({
        deviceMode: 'auto',
        vid: 0xFFFF,
        pid: 0x0035,
        parentPid: 1234
    });

    assert.ok(auto.indexOf('--listen') !== -1);
    assert.ok(auto.indexOf('--vid=0xFFFF') !== -1);
    assert.ok(auto.indexOf('--pid=0x0035') !== -1);
    assert.ok(auto.indexOf('--parent-pid=1234') !== -1);
    assert.equal(auto.indexOf('--any'), -1);

    const selected = rawInput.buildArguments({
        deviceMode: 'selected',
        devicePath: '\\\\?\\HID#VID_FFFF&PID_0035&MI_00#9&237fdf6f&0&0000#{884b96c3}',
        vid: 0xFFFF,
        pid: 0x0035
    });

    assert.ok(selected.indexOf('--path=\\\\?\\HID#VID_FFFF&PID_0035&MI_00#9&237fdf6f&0&0000#{884b96c3}') !== -1);

    const any = rawInput.buildArguments({ deviceMode: 'any', vid: 0xFFFF, pid: 0x0035 });
    assert.ok(any.indexOf('--any') !== -1);
    assert.equal(any.indexOf('--vid=0xFFFF'), -1);
});

test('parseLine mengabaikan baris kosong/rusak dan menerima JSON objek', function () {
    assert.equal(rawInput.parseLine(''), null);
    assert.equal(rawInput.parseLine('   '), null);
    assert.equal(rawInput.parseLine('bukan json'), null);
    assert.equal(rawInput.parseLine('[]'), null);

    const parsed = rawInput.parseLine('{"type":"scan","uid":"123"}');
    assert.equal(parsed.type, 'scan');
    assert.equal(parsed.uid, '123');
});

test('normalizeDevice menyeragamkan data helper untuk editor', function () {
    const device = rawInput.normalizeDevice({
        path: 'path-1',
        name: 'HID Keyboard Device',
        displayName: 'HID Keyboard Device (VID:FFFF PID:0035) [Keyboard]',
        vendorId: 0xFFFF,
        productId: 0x0035,
        typeName: 'Keyboard',
        keyboard: true
    });

    assert.equal(device.path, 'path-1');
    assert.equal(device.label, 'HID Keyboard Device (VID:FFFF PID:0035) [Keyboard]');
    assert.equal(device.vendorIdHex, '0xFFFF');
    assert.equal(device.productIdHex, '0x0035');
    assert.equal(device.interface, null);
    assert.equal(device.source, 'rawinput');
    assert.equal(device.keyboard, true);
});

test('backend meneruskan ready, status, dan scan dari helper', async function () {
    const fake = new FakeChild();
    const events = {
        ready: null,
        statuses: [],
        scans: [],
        logs: []
    };

    const handle = rawInput.start({
        helperPath: process.execPath,
        parentPid: 99,
        deviceMode: 'auto',
        vid: 0xFFFF,
        pid: 0x0035,
        spawn: function () {
            return fake;
        },
        onReady: function (message) {
            events.ready = message;
        },
        onStatus: function (state, message) {
            events.statuses.push({ state: state, message: message });
        },
        onScan: function (scan) {
            events.scans.push(scan);
        },
        onLog: function (level, message) {
            events.logs.push({ level: level, message: message });
        }
    });

    assert.equal(handle.isRunning(), true);

    fake.stdout.write('{"type":"ready","version":"1.0.0","device":{"path":"p","name":"Reader","vendorId":65535,"productId":53}}\n');
    fake.stdout.write('{"type":"status","state":"connected","device":{"path":"p","name":"Reader","vendorId":65535,"productId":53}}\n');
    fake.stdout.write('{"type":"scan","uid":" 001234 ","source":"keyboard","device":{"path":"p","name":"Reader","vendorId":65535,"productId":53}}\n');

    await delay(30);

    assert.ok(events.ready);
    assert.equal(events.ready.version, '1.0.0');
    assert.deepEqual(events.statuses.map(function (entry) { return entry.state; }), ['connected']);
    assert.equal(events.scans.length, 1);
    assert.equal(events.scans[0].uid, '001234');
    assert.equal(events.scans[0].device.vendorIdHex, '0xFFFF');

    let closed = false;
    handle.close(function () {
        closed = true;
    });

    fake.emit('exit', 0, null);
    await delay(20);

    assert.equal(closed, true);
    assert.ok(fake.stdinWrites.join('').indexOf('stop') !== -1);
});

test('helper --list mengembalikan JSON daftar perangkat', {
    skip: process.platform !== 'win32' || !fs.existsSync(HELPER_PATH)
}, async function () {
    const devices = await new Promise(function (resolve, reject) {
        rawInput.listDevices(HELPER_PATH, function (err, result) {
            if (err) {
                reject(err);
                return;
            }
            resolve(result);
        });
    });

    assert.ok(Array.isArray(devices));

    devices.forEach(function (device) {
        assert.equal(typeof device.path, 'string');
        assert.equal(typeof device.typeName, 'string');
    });
});
