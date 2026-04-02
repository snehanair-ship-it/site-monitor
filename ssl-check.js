/**
 * SSL certificate and domain expiry checker.
 */

const https = require('https');
const { URL } = require('url');

/**
 * Get SSL certificate details for a URL.
 * Returns issuer, valid from/to, days remaining.
 */
function checkSSL(siteUrl) {
  return new Promise((resolve) => {
    try {
      const url = new URL(siteUrl);
      if (url.protocol !== 'https:') {
        return resolve({ ssl: false, reason: 'Not HTTPS' });
      }

      const options = {
        hostname: url.hostname,
        port: 443,
        method: 'HEAD',
        rejectUnauthorized: false,
        timeout: 10000,
      };

      const req = https.request(options, (res) => {
        const cert = res.socket.getPeerCertificate();
        if (!cert || !cert.valid_to) {
          return resolve({ ssl: true, error: 'No certificate info available' });
        }

        const validFrom = new Date(cert.valid_from);
        const validTo = new Date(cert.valid_to);
        const now = new Date();
        const daysRemaining = Math.floor((validTo.getTime() - now.getTime()) / 86400000);
        const isValid = now >= validFrom && now <= validTo && res.socket.authorized !== false;

        resolve({
          ssl: true,
          valid: isValid,
          issuer: cert.issuer ? (cert.issuer.O || cert.issuer.CN || 'Unknown') : 'Unknown',
          subject: cert.subject ? cert.subject.CN : url.hostname,
          validFrom: validFrom.toISOString(),
          validTo: validTo.toISOString(),
          daysRemaining,
          serialNumber: cert.serialNumber || null,
        });
      });

      req.on('error', (err) => {
        resolve({ ssl: true, error: err.message });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({ ssl: true, error: 'Timeout' });
      });

      req.end();
    } catch (err) {
      resolve({ ssl: false, error: err.message });
    }
  });
}

module.exports = { checkSSL };
