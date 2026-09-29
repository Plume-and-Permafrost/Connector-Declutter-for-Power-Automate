'use strict';
// Environment identity helpers.
//
// Every Power Automate designer request goes to a host that encodes the
// environment id: strip the dashes, lowercase, then all-but-the-last-two
// characters, a dot, and the last two. That holds for GUID environments and for
// the "Default-<tenant guid>" form alike:
//
//   0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9
//     -> 0a1b2c3d4e5f60718293a4b5c6d7e8.f9.environment.api.powerplatform.com
//   Default-1234abcd-5678-90ef-ab12-cd34ef567890
//     -> default1234abcd567890efab12cd34ef5678.90.environment.api.powerplatform.com
//
// Going the other way is ambiguous (nothing in the host says where the dashes
// went), so everything is compared in "canonical" form - dashes stripped,
// lowercased - which both directions agree on.
var __cdpa = globalThis.__cdpa || (globalThis.__cdpa = {});

__cdpa.env = (function () {
  var ENV_HOST_RE = /^([0-9a-z]+)\.([0-9a-z]{2})\.environment\.api\.powerplatform\.com$/i;

  // Canonical comparison key for an environment id.
  function canonical(id) {
    return String(id == null ? '' : id).replace(/-/g, '').toLowerCase();
  }

  function hostFromEnvironmentId(id) {
    var s = canonical(id);
    if (s.length < 3) return null;
    return s.slice(0, -2) + '.' + s.slice(-2) + '.environment.api.powerplatform.com';
  }

  function canonicalFromHost(host) {
    var m = ENV_HOST_RE.exec(String(host == null ? '' : host));
    return m ? (m[1] + m[2]).toLowerCase() : null;
  }

  function canonicalFromUrl(url) {
    try {
      return canonicalFromHost(new URL(String(url), 'https://make.powerautomate.com').hostname);
    } catch (e) {
      return null;
    }
  }

  // Fallback for when we only have the SPA route: /environments/{id}/...
  function canonicalFromPath(pathname) {
    var m = /\/environments\/([^/?#]+)/i.exec(String(pathname == null ? '' : pathname));
    if (!m) return null;
    try {
      return canonical(decodeURIComponent(m[1]));
    } catch (e) {
      return canonical(m[1]);
    }
  }

  // Best-effort display form. A bare 32-hex canonical is a GUID; the default
  // environment carries a "default" prefix in front of the tenant GUID.
  function toDisplay(canonicalId) {
    var s = canonical(canonicalId);
    var prefix = '';
    if (s.length === 39 && s.slice(0, 7) === 'default') {
      prefix = 'Default-';
      s = s.slice(7);
    }
    if (!/^[0-9a-f]{32}$/.test(s)) return prefix + s;
    return prefix + [s.slice(0, 8), s.slice(8, 12), s.slice(12, 16), s.slice(16, 20), s.slice(20)].join('-');
  }

  return {
    canonical: canonical,
    hostFromEnvironmentId: hostFromEnvironmentId,
    canonicalFromHost: canonicalFromHost,
    canonicalFromUrl: canonicalFromUrl,
    canonicalFromPath: canonicalFromPath,
    toDisplay: toDisplay
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = __cdpa.env;
