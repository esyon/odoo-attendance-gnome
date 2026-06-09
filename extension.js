// SPDX-License-Identifier: GPL-2.0-or-later
// Odoo Attendance — GNOME Shell panel indicator.
// Shows current hr.attendance status and toggles check in/out via the JSON-2 API.

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {OdooClient, parseOdooUtcToLocal, hoursFromRecords} from './lib/odooClient.js';
import * as Secrets from './lib/secrets.js';

const ICON_CHECKED_IN = 'media-playback-start-symbolic';
const ICON_CHECKED_OUT = 'media-playback-stop-symbolic';
const ICON_UNCONFIGURED = 'dialog-question-symbolic';

function formatHM(hoursFloat) {
    const totalMin = Math.max(0, Math.round((hoursFloat || 0) * 60));
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return `${h}h ${m.toString().padStart(2, '0')}m`;
}

function formatTime(odooUtcStr) {
    const dt = parseOdooUtcToLocal(odooUtcStr);
    return dt ? dt.format('%H:%M') : '—';
}

const OdooAttendanceIndicator = GObject.registerClass(
class OdooAttendanceIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, 'Odoo Attendance');
        this._extension = extension;
        this._settings = extension.getSettings();

        this._client = null;
        this._apiKey = null;
        this._uid = 0;
        this._employeeId = 0;
        this._checkedIn = false;
        this._openAttendance = null; // {id, check_in}
        this._busy = false;
        this._refreshing = false;
        this._timerId = 0;
        this._cancellable = new Gio.Cancellable();
        this._destroyed = false;
        this._reloadGen = 0;

        // --- panel button ---
        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._icon = new St.Icon({
            icon_name: ICON_UNCONFIGURED,
            style_class: 'system-status-icon',
        });
        this._panelLabel = new St.Label({
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'odoo-panel-label',
        });
        box.add_child(this._icon);
        box.add_child(this._panelLabel);
        this.add_child(box);

        this._buildMenu();

        // React to config changes and menu opening.
        this._settingsChangedId = this._settings.connect(
            'changed', (_s, key) => this._onSettingChanged(key));
        this._openStateId = this.menu.connect('open-state-changed', (_m, open) => {
            if (open)
                this._refresh();
        });

        this._reloadConfig();
    }

    _buildMenu() {
        // Header: employee name + state.
        this._headerItem = new PopupMenu.PopupMenuItem('', {
            reactive: false,
            can_focus: false,
        });
        this._headerItem.label.style_class = 'odoo-header';
        this.menu.addMenuItem(this._headerItem);

        this._stateItem = new PopupMenu.PopupMenuItem('', {
            reactive: false,
            can_focus: false,
        });
        this.menu.addMenuItem(this._stateItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Info rows.
        this._hoursItem = this._infoRow();
        this._lastInItem = this._infoRow();

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Today's records.
        this._recordsHeader = new PopupMenu.PopupMenuItem(_('Today'), {
            reactive: false,
            can_focus: false,
        });
        this._recordsHeader.label.style_class = 'odoo-subheader';
        this.menu.addMenuItem(this._recordsHeader);
        this._recordsSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._recordsSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Actions.
        this._toggleItem = new PopupMenu.PopupMenuItem(_('Check In / Out'));
        this._toggleItem.connect('activate', () => this._onToggle());
        this.menu.addMenuItem(this._toggleItem);

        this._refreshItem = new PopupMenu.PopupMenuItem(_('Refresh now'));
        this._refreshItem.connect('activate', () => this._refresh());
        this.menu.addMenuItem(this._refreshItem);

        const settingsItem = new PopupMenu.PopupMenuItem(_('Settings'));
        settingsItem.connect('activate', () => this._extension.openPreferences());
        this.menu.addMenuItem(settingsItem);
    }

    _infoRow() {
        const item = new PopupMenu.PopupMenuItem('', {
            reactive: false,
            can_focus: false,
        });
        this.menu.addMenuItem(item);
        return item;
    }

    // React to a single settings key. Only a base-url change needs a fresh
    // keyring lookup + new client; the other keys are cheap, so we avoid a
    // keyring round-trip on every keystroke while editing in the prefs window.
    _onSettingChanged(key) {
        switch (key) {
        case 'base-url':
            this._reloadConfig();
            break;
        case 'refresh-interval':
            this._restartTimer();
            break;
        default: // login-email, user-id, employee-id, show-hours-label
            this._reloadFields();
            this._refresh();
            break;
        }
    }

    _reloadFields() {
        this._login = this._settings.get_string('login-email');
        this._uid = this._settings.get_int('user-id');
        this._employeeId = this._settings.get_int('employee-id');
        this._showLabel = this._settings.get_boolean('show-hours-label');
    }

    async _reloadConfig() {
        const gen = ++this._reloadGen;
        this._baseUrl = this._settings.get_string('base-url');
        this._reloadFields();

        this._client?.destroy();
        this._client = null;
        try {
            this._apiKey = await Secrets.lookupKey(this._baseUrl, this._cancellable);
        } catch (e) {
            this._apiKey = null;
            if (!e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                logError(e, 'odoo-attendance: keyring lookup failed');
        }

        // Bail out if we were disabled or superseded by a newer reload while
        // the async keyring lookup was in flight — otherwise we would re-arm
        // the timer and re-create the client after destroy().
        if (this._destroyed || gen !== this._reloadGen)
            return;

        if (this._baseUrl && this._apiKey)
            this._client = new OdooClient(this._baseUrl, this._apiKey);

        this._restartTimer();
        this._refresh();
    }

    _restartTimer() {
        if (this._destroyed)
            return;
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
        const interval = Math.max(15, this._settings.get_int('refresh-interval'));
        this._timerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, interval, () => {
                this._refresh();
                return GLib.SOURCE_CONTINUE;
            });
    }

    _isConfigured() {
        return !!(this._client && this._uid > 0 && this._employeeId > 0);
    }

    async _refresh() {
        if (this._destroyed || this._refreshing)
            return;
        if (!this._isConfigured()) {
            this._renderUnconfigured();
            return;
        }
        this._refreshing = true;
        try {
            const [open, records] = await Promise.all([
                this._client.getOpenAttendance(this._uid, this._cancellable),
                this._client.getTodayRecords(this._uid, this._cancellable),
            ]);
            if (this._destroyed)
                return;
            this._openAttendance = open;
            this._checkedIn = !!open;
            this._render(records);
        } catch (e) {
            if (!e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                this._renderError(e);
        } finally {
            this._refreshing = false;
        }
    }

    _renderUnconfigured() {
        this._icon.icon_name = ICON_UNCONFIGURED;
        this._icon.style_class = 'system-status-icon';
        this._panelLabel.text = '';
        this._headerItem.label.text = _('Odoo Attendance');
        this._stateItem.label.text = _('Not configured — open Settings');
        this._hoursItem.label.text = '';
        this._lastInItem.label.text = '';
        this._recordsSection.removeAll();
        this._toggleItem.label.text = _('Settings…');
        this._toggleItem.reactive = false;
    }

    _renderError(e) {
        this._icon.icon_name = 'network-error-symbolic';
        this._stateItem.label.text = _('Connection error');
        logError(e, 'odoo-attendance: refresh failed');
    }

    _render(records) {
        const checkedIn = this._checkedIn;
        this._icon.icon_name = checkedIn ? ICON_CHECKED_IN : ICON_CHECKED_OUT;
        this._icon.style_class = checkedIn
            ? 'system-status-icon odoo-in'
            : 'system-status-icon odoo-out';

        const hours = hoursFromRecords(records);
        this._panelLabel.text =
            this._showLabel && checkedIn ? ` ${formatHM(hours)}` : '';

        this._headerItem.label.text = _('Odoo Attendance');
        this._stateItem.label.text = checkedIn
            ? _('Checked in')
            : _('Checked out');

        this._hoursItem.label.text = `${_('Hours today')}:  ${formatHM(hours)}`;
        const lastIn = this._openAttendance?.check_in
            ?? (records?.length ? records[records.length - 1].check_in : null);
        this._lastInItem.label.text =
            `${_('Last check-in')}:  ${formatTime(lastIn)}`;

        // Records list.
        this._recordsSection.removeAll();
        if (!records?.length) {
            const none = new PopupMenu.PopupMenuItem(_('No records today'), {
                reactive: false,
                can_focus: false,
            });
            none.label.style_class = 'odoo-record';
            this._recordsSection.addMenuItem(none);
        } else {
            for (const r of records) {
                const start = formatTime(r.check_in);
                const end = r.check_out ? formatTime(r.check_out) : _('now');
                const dur = r.check_out ? `  (${formatHM(r.worked_hours)})` : '';
                const item = new PopupMenu.PopupMenuItem(
                    `${start} – ${end}${dur}`, {reactive: false, can_focus: false});
                item.label.style_class = 'odoo-record';
                this._recordsSection.addMenuItem(item);
            }
        }

        this._toggleItem.reactive = !this._busy;
        this._toggleItem.label.text = this._busy
            ? _('Working…')
            : (checkedIn ? _('Check Out') : _('Check In'));
    }

    async _onToggle() {
        if (this._busy || this._destroyed || !this._isConfigured())
            return;
        this._busy = true;
        this._toggleItem.reactive = false;
        const wasCheckedIn = this._checkedIn;
        this._toggleItem.label.text = _('Working…');
        try {
            if (wasCheckedIn) {
                let openId = this._openAttendance?.id;
                if (!openId) {
                    const open =
                        await this._client.getOpenAttendance(this._uid, this._cancellable);
                    openId = open?.id;
                }
                if (!openId)
                    throw new Error(_('No open attendance to check out.'));
                await this._client.checkOut(openId, this._cancellable);
                Main.notify(_('Odoo Attendance'), _('Checked out.'));
            } else {
                await this._client.checkIn(this._employeeId, this._cancellable);
                Main.notify(_('Odoo Attendance'), _('Checked in.'));
            }
        } catch (e) {
            // Disabled mid-request: the cancellable fired. Don't toast/log.
            if (this._destroyed ||
                e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            Main.notifyError(_('Odoo Attendance'),
                e?.message ?? _('Action failed.'));
            logError(e, 'odoo-attendance: toggle failed');
        } finally {
            this._busy = false;
            await this._refresh(); // self-guards on _destroyed
        }
    }

    destroy() {
        this._destroyed = true;
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }
        if (this._openStateId) {
            this.menu.disconnect(this._openStateId);
            this._openStateId = 0;
        }
        this._cancellable?.cancel();
        this._client?.destroy();
        this._client = null;
        super.destroy();
    }
});

export default class OdooAttendanceExtension extends Extension {
    enable() {
        this._indicator = new OdooAttendanceIndicator(this);
        Main.panel.addToStatusArea('odoo-attendance', this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
