require('dotenv').config();
const { verifyEmailConnection } = require('../services/emailService');

verifyEmailConnection()
  .then(() => {
    console.log('SMTP_VERIFY=PASS');
  })
  .catch(err => {
    const safeCode = ['EMAIL_CONFIG_MISSING', 'EAUTH', 'ETIMEDOUT', 'ECONNECTION', 'ECONNREFUSED', 'ESOCKET', 'EENVELOPE', 'EMESSAGE'].includes(err.code)
      ? err.code
      : 'SMTP_ERROR';
    console.error(`SMTP_VERIFY=FAIL (${safeCode})`);
    process.exitCode = 1;
  });
