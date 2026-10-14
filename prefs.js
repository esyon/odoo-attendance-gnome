// SPDX-License-Identifier: GPL-2.0-or-later
// Preferences for Odoo Attendance.
// Connection settings live in GSettings; the API key lives in the keyring.

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';

import {ExtensionPreferences, gettext as _}
    from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {OdooClient} from './lib/odooClient.js';
import * as Secrets from './lib/secrets.js';

export default class OdooAttendancePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: _('Odoo Attendance'),
            icon_name: 'preferences-system-time-symbolic',
        });
        window.add(page);

        // --- Connection -----------------------------------------------------
        const conn = new Adw.PreferencesGroup({title: _('Connection')});
        page.add(conn);

        const urlRow = new Adw.EntryRow({title: _('Base URL')});
        settings.bind('base-url', urlRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        conn.add(urlRow);

        const loginRow = new Adw.EntryRow({title: _('Login (email)')});
        settings.bind('login-email', loginRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        conn.add(loginRow);

        const keyRow = new Adw.PasswordEntryRow({title: _('API key')});
        conn.add(keyRow);

        // Prefill the key from the keyring (async).
        Secrets.lookupKey(settings.get_string('base-url'))
            .then(key => {
                if (key)
                    keyRow.text = key;
            })
            .catch(e => logError(e, 'odoo-attendance prefs: key lookup'));

        // --- Behavior -------------------------------------------------------
        const behavior = new Adw.PreferencesGroup({title: _('Behavior')});
        page.add(behavior);

        const intervalRow = new Adw.SpinRow({
            title: _('Refresh interval (seconds)'),
            adjustment: new Gtk.Adjustment({
                lower: 15, upper: 3600, step_increment: 5, page_increment: 30,
            }),
        });
        intervalRow.value = settings.get_int('refresh-interval');
        intervalRow.connect('notify::value', () =>
            settings.set_int('refresh-interval', intervalRow.value));
        behavior.add(intervalRow);

        const labelRow = new Adw.SwitchRow({
            title: _('Show hours in panel'),
            subtitle: _('Display today’s worked hours next to the icon'),
        });
        settings.bind('show-hours-label', labelRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        behavior.add(labelRow);

        // --- Status / actions ----------------------------------------------
        const status = new Adw.PreferencesGroup({
            title: _('Employee'),
            description: _('Resolve and cache your employee id. Saves the API key to the keyring.'),
        });
        page.add(status);

        const empRow = new Adw.ActionRow({title: _('Resolved employee id')});
        const empLabel = new Gtk.Label({label: this._empText(settings)});
        empRow.add_suffix(empLabel);
        status.add(empRow);

        const testRow = new Adw.ActionRow({
            title: _('Test connection & resolve employee'),
            use_markup: false,
        });
        const testBtn = new Gtk.Button({
            label: _('Test'),
            valign: Gtk.Align.CENTER,
        });
        testRow.add_suffix(testBtn);
        testRow.activatable_widget = testBtn;
        status.add(testRow);

        testBtn.connect('clicked', () => {
            this._onTest(window, settings, urlRow, loginRow, keyRow, empLabel, testBtn)
                .catch(e => {
                    logError(e, 'odoo-attendance prefs: test failed');
                    this._toast(window, _('Error: %s').format(e?.message ?? e));
                    testBtn.sensitive = true;
                    testBtn.label = _('Test');
                });
        });

        // Persist the key to the keyring when the window closes.
        window.connect('close-request', () => {
            const url = urlRow.text.trim();
            const key = keyRow.text.trim();
            if (url && key)
                Secrets.storeKey(url, key).catch(
                    e => logError(e, 'odoo-attendance prefs: store on close'));
            return false;
        });
    }

    _empText(settings) {
        const id = settings.get_int('employee-id');
        return id > 0 ? String(id) : _('not resolved');
    }

    async _onTest(window, settings, urlRow, loginRow, keyRow, empLabel, testBtn) {
        const baseUrl = urlRow.text.trim();
        const login = loginRow.text.trim();
        const key = keyRow.text.trim();
        if (!baseUrl || !login || !key) {
            this._toast(window, _('Fill in URL, login and API key first.'));
            return;
        }

        testBtn.sensitive = false;
        testBtn.label = _('Testing…');

        const client = new OdooClient(baseUrl, key);
        try {
            const user = await client.resolveUser(login);
            if (!user) {
                this._toast(window, _('No user found for that login.'));
                return;
            }
            const emp = await client.resolveEmployee(user.id);
            if (!emp) {
                this._toast(window, _('User %s has no linked employee.').format(user.name));
                return;
            }
            // Only persist the key once we know it actually authenticates.
            await Secrets.storeKey(baseUrl, key);
            settings.set_int('user-id', user.id);
            settings.set_int('employee-id', emp.id);
            empLabel.label = String(emp.id);
            this._toast(window,
                _('Connected as %s (employee #%d).').format(emp.name, emp.id));
        } finally {
            client.destroy();
            testBtn.sensitive = true;
            testBtn.label = _('Test');
        }
    }

    _toast(window, text) {
        window.add_toast(new Adw.Toast({title: text, timeout: 4}));
    }
}
