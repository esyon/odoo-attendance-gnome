// SPDX-License-Identifier: GPL-2.0-or-later
// Read-only self-test of the JSON-2 client. No mutations.
// Usage: gjs -m selftest.js <api-key> <login-email> [base-url]
//   base-url defaults to https://odoo.example.com — pass your own instance.
import GLib from 'gi://GLib';
import system from 'system';
import {OdooClient, utcNowOdoo, localMidnightUtc, hoursFromRecords}
    from './lib/odooClient.js';

const [key, login, baseUrlArg] = system.programArgs;
if (!key || !login) {
    printerr('usage: gjs -m selftest.js <api-key> <login-email> [base-url]');
    system.exit(2);
}

const baseUrl = baseUrlArg || 'https://odoo.example.com';
const client = new OdooClient(baseUrl, key);
const loop = GLib.MainLoop.new(null, false);

(async () => {
    try {
        print('baseUrl     = ' + baseUrl);
        print('utcNow      = ' + utcNowOdoo());
        print('localMidUtc = ' + localMidnightUtc());

        const user = await client.resolveUser(login);
        print('USER    = ' + JSON.stringify(user));
        if (!user)
            throw new Error(`No user found for login "${login}"`);

        const uid = user.id;
        const emp = await client.resolveEmployee(uid);
        print('EMP     = ' + JSON.stringify(emp));
        const open = await client.getOpenAttendance(uid);
        print('OPEN    = ' + JSON.stringify(open));
        const recs = await client.getTodayRecords(uid);
        print('RECORDS = ' + JSON.stringify(recs));
        print('HOURS   = ' + hoursFromRecords(recs).toFixed(3));
        print('STATE   = ' + (open ? 'checked_in' : 'checked_out'));
    } catch (e) {
        print('ERROR   = ' + e + (e.payload ? ' :: ' + JSON.stringify(e.payload) : ''));
    } finally {
        client.destroy();
        loop.quit();
    }
})();

loop.run();
