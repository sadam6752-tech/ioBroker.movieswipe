'use strict';

const os = require('node:os');

/**
 * Первый не-loopback IPv4 адрес (без link-local 169.254.x.x), иначе null
 */
function findLanAddress() {
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const addr of iface || []) {
      if (addr.family === 'IPv4' && !addr.internal && !addr.address.startsWith('169.254.')) {
        return addr.address;
      }
    }
  }
  return null;
}

module.exports = { findLanAddress };
