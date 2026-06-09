// SPDX-License-Identifier: GPL-2.0-or-later
// Thin client for the Odoo 19 JSON-2 API (/json/2/<model>/<method>).
//
// Body model (per Odoo docs): a JSON object with the method's named parameters,
// plus optional `ids` (recordset) and `context`. There are no positional args.
//   search_read -> {domain, fields, limit, order}
//   write(self, vals)        -> {ids:[id], vals:{...}}
//   create(self, vals_list)  -> {vals_list:[{...}]}
// Datetimes are stored as naive UTC; we always send/parse UTC.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');

// --- time helpers -----------------------------------------------------------

// Current UTC time in Odoo's datetime format.
export function utcNowOdoo() {
    return GLib.DateTime.new_now_utc().format('%Y-%m-%d %H:%M:%S');
}

// Local midnight expressed as a UTC Odoo datetime string (for "today" domains).
export function localMidnightUtc() {
    const now = GLib.DateTime.new_now_local();
    const midnight = GLib.DateTime.new_local(
        now.get_year(), now.get_month(), now.get_day_of_month(), 0, 0, 0);
    return midnight.to_utc().format('%Y-%m-%d %H:%M:%S');
}

// Parse a naive-UTC Odoo datetime string into a UTC GLib.DateTime (or null).
export function parseOdooUtc(str) {
    if (!str)
        return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(str);
    if (!m)
        return null;
    return GLib.DateTime.new(
        GLib.TimeZone.new_utc(),
        Number(m[1]), Number(m[2]), Number(m[3]),
        Number(m[4]), Number(m[5]), Number(m[6]));
}

// Parse a naive-UTC Odoo datetime string into a local GLib.DateTime (or null).
export function parseOdooUtcToLocal(str) {
    const utc = parseOdooUtc(str);
    return utc ? utc.to_local() : null;
}

// Total worked hours today from attendance rows. Closed rows contribute
// worked_hours; an open row contributes elapsed time since its check_in.
export function hoursFromRecords(records) {
    const nowUtc = GLib.DateTime.new_now_utc();
    let hours = 0;
    for (const r of records ?? []) {
        if (r.check_out) {
            hours += r.worked_hours || 0;
        } else {
            const start = parseOdooUtc(r.check_in);
            if (start)
                hours += nowUtc.difference(start) / 3600.0e6; // µs → h
        }
    }
    return hours;
}

// --- client -----------------------------------------------------------------

export class OdooError extends Error {
    constructor(message, {status = 0, name = '', payload = null} = {}) {
        super(message);
        this.name = 'OdooError';
        this.status = status;
        this.odooName = name;
        this.payload = payload;
    }
}

export class OdooClient {
    constructor(baseUrl, apiKey) {
        this._baseUrl = (baseUrl || '').replace(/\/+$/, '');
        this._apiKey = apiKey || '';
        this._session = new Soup.Session();
        this._session.timeout = 15;
    }

    get configured() {
        return !!(this._baseUrl && this._apiKey);
    }

    async _call(model, method, params, cancellable = null) {
        const url = `${this._baseUrl}/json/2/${model}/${method}`;
        const msg = Soup.Message.new('POST', url);
        const headers = msg.get_request_headers();
        headers.append('Authorization', `bearer ${this._apiKey}`);

        const bodyStr = JSON.stringify(params ?? {});
        const bytes = GLib.Bytes.new(new TextEncoder().encode(bodyStr));
        msg.set_request_body_from_bytes('application/json; charset=utf-8', bytes);

        const respBytes = await this._session.send_and_read_async(
            msg, GLib.PRIORITY_DEFAULT, cancellable);
        const status = msg.get_status();
        const data = respBytes ? respBytes.get_data() : null;
        const text = data && data.length ? new TextDecoder().decode(data) : '';

        let parsed = null;
        if (text) {
            try {
                parsed = JSON.parse(text);
            } catch {
                parsed = null;
            }
        }

        if (status < 200 || status >= 300) {
            const name = parsed?.name ?? '';
            const message = parsed?.message ?? text ?? `HTTP ${status}`;
            throw new OdooError(message, {status, name, payload: parsed});
        }
        return parsed;
    }

    // Resolve the Odoo user id for a login (email). Returns {id, name} or null.
    async resolveUser(login, cancellable = null) {
        const rows = await this._call('res.users', 'search_read', {
            domain: [['login', '=', login]],
            fields: ['id', 'name', 'login'],
            limit: 1,
        }, cancellable);
        return rows?.length ? rows[0] : null;
    }

    // Resolve the employee linked to a user id. Returns {id, name, ...} or null.
    async resolveEmployee(uid, cancellable = null) {
        const rows = await this._call('hr.employee', 'search_read', {
            domain: [['user_id', '=', uid]],
            fields: ['id', 'name'],
            limit: 1,
        }, cancellable);
        return rows?.length ? rows[0] : null;
    }

    // The currently open attendance (no check_out), or null. Scoped by user id.
    async getOpenAttendance(uid, cancellable = null) {
        const rows = await this._call('hr.attendance', 'search_read', {
            domain: [['employee_id.user_id', '=', uid], ['check_out', '=', false]],
            fields: ['id', 'check_in', 'check_out'],
            order: 'check_in desc',
            limit: 1,
        }, cancellable);
        return rows?.length ? rows[0] : null;
    }

    // Today's attendance records (local day), oldest first. Scoped by user id.
    async getTodayRecords(uid, cancellable = null) {
        return await this._call('hr.attendance', 'search_read', {
            domain: [['employee_id.user_id', '=', uid],
                     ['check_in', '>=', localMidnightUtc()]],
            fields: ['id', 'check_in', 'check_out', 'worked_hours'],
            order: 'check_in',
        }, cancellable) ?? [];
    }

    // Create a new open attendance (check in). Returns created id(s) payload.
    async checkIn(employeeId, cancellable = null) {
        return await this._call('hr.attendance', 'create', {
            vals_list: [{employee_id: employeeId, check_in: utcNowOdoo()}],
        }, cancellable);
    }

    // Close an open attendance (check out).
    async checkOut(attendanceId, cancellable = null) {
        return await this._call('hr.attendance', 'write', {
            ids: [attendanceId],
            vals: {check_out: utcNowOdoo()},
        }, cancellable);
    }

    destroy() {
        try {
            this._session?.abort();
        } catch {
            // ignore
        }
        this._session = null;
    }
}
