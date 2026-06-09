// SPDX-License-Identifier: GPL-2.0-or-later
// Stores the Odoo API key in the system keyring (libsecret / GNOME Keyring)
// instead of dconf, so it is encrypted at rest with the login keyring.

import Gio from 'gi://Gio';
import Secret from 'gi://Secret';

// One secret item per base URL, so multiple Odoo instances don't collide.
const SCHEMA = new Secret.Schema(
    'de.esyon.odoo-attendance',
    Secret.SchemaFlags.NONE,
    { base_url: Secret.SchemaAttributeType.STRING },
);

Gio._promisify(Secret, 'password_store', 'password_store_finish');
Gio._promisify(Secret, 'password_lookup', 'password_lookup_finish');
Gio._promisify(Secret, 'password_clear', 'password_clear_finish');

function attrs(baseUrl) {
    return { base_url: baseUrl };
}

export async function storeKey(baseUrl, apiKey, cancellable = null) {
    await Secret.password_store(
        SCHEMA,
        attrs(baseUrl),
        Secret.COLLECTION_DEFAULT,
        `Odoo Attendance API key (${baseUrl})`,
        apiKey,
        cancellable,
    );
}

// Returns the stored key string, or null if none is stored.
export async function lookupKey(baseUrl, cancellable = null) {
    return await Secret.password_lookup(SCHEMA, attrs(baseUrl), cancellable);
}

export async function clearKey(baseUrl, cancellable = null) {
    await Secret.password_clear(SCHEMA, attrs(baseUrl), cancellable);
}
