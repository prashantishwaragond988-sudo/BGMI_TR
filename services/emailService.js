const nodemailer = require('nodemailer');

let transporter;

class EmailServiceError extends Error {
  constructor(code) {
    super(code);
    this.name = 'EmailServiceError';
    this.code = code;
  }
}

function getTransporter() {
  const user = String(process.env.GMAIL_USER || '').trim();
  const appPassword = String(process.env.GMAIL_APP_PASSWORD || '').replace(/\s/g, '');
  if (!user || !appPassword) throw new EmailServiceError('EMAIL_CONFIG_MISSING');

  // Rebuild if the process environment is updated during local development.
  if (!transporter || transporter.__gmailUser !== user || transporter.__gmailPassword !== appPassword) {
    transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user, pass: appPassword },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
      tls: { minVersion: 'TLSv1.2' }
    });
    // Used only for local cache invalidation; never logged or returned.
    Object.defineProperties(transporter, {
      __gmailUser: { value: user, configurable: true },
      __gmailPassword: { value: appPassword, configurable: true }
    });
  }
  return transporter;
}

function safeName(value, fallback = 'Participant') {
  return String(value || fallback).replace(/[\r\n\t]/g, ' ').trim().slice(0, 120);
}

function safeError(err) {
  const allowed = new Set(['EAUTH', 'ETIMEDOUT', 'ECONNECTION', 'ECONNREFUSED', 'ESOCKET', 'EENVELOPE', 'EMESSAGE']);
  const code = err?.code === 'EMAIL_CONFIG_MISSING' ? 'EMAIL_CONFIG_MISSING' : allowed.has(err?.code) ? err.code : 'SMTP_ERROR';
  return new EmailServiceError(code);
}

async function verifyEmailConnection() {
  try {
    await getTransporter().verify();
    return true;
  } catch (err) {
    throw safeError(err);
  }
}

async function send({ to, subject, text }) {
  try {
    const mailer = getTransporter();
    const user = String(process.env.GMAIL_USER).trim();
    await mailer.sendMail({
      from: { name: 'RG BGMI Tournament - SARA SHADOWS SQUAD', address: user },
      to,
      subject,
      text
    });
    return true;
  } catch (err) {
    // Do not log SMTP errors: some providers include account or server details.
    throw safeError(err);
  }
}

async function sendAccountWelcomeEmail({ to, name }) {
  const participant = safeName(name);
  return send({
    to,
    subject: 'RG BGMI Tournament - Account Created',
    text: `Hello ${participant},\n\nYour account for the RG BGMI Tournament by SARA SHADOWS SQUAD has been created successfully.\n\nSARA SHADOWS SQUAD`
  });
}

async function sendTournamentRegistrationEmail({ to, participantName, squadName, registrationNumber }) {
  const participant = safeName(participantName);
  const squad = safeName(squadName, 'Squad');
  const regNumber = safeName(registrationNumber, '');
  return send({
    to,
    subject: 'RG BGMI Tournament Registration Received - Payment Verification Pending',
    text: `RG BGMI TOURNAMENT\nSARA SHADOWS SQUAD\n\nRegistration confirmation received.\n\nParticipant / Team Leader: ${participant}\nRegistered email: ${to}\nSquad Name: ${squad}\nRegistration Number: ${regNumber}\nEntry Fee: INR 50\nPayment status: PENDING VERIFICATION\n\nThe organizer will manually verify your payment. This email confirms receipt only; your registration is not approved until payment is verified. A UPI transaction ID alone is not proof of payment. You will receive a separate confirmation email if the organizer approves your payment.\n\nSARA SHADOWS SQUAD`
  });
}

async function sendApprovalEmail({ to, participantName, squadName, registrationNumber }) {
  const participant = safeName(participantName);
  const squad = safeName(squadName, 'your squad');
  const regNumber = safeName(registrationNumber, '');
  return send({
    to,
    subject: 'RG BGMI Tournament Registration Confirmed - SARA SHADOWS SQUAD',
    text: `Hello ${participant},\n\nCongratulations! Your squad registration for the RG BGMI Tournament by SARA SHADOWS SQUAD has been approved.\n\nSquad Name: ${squad}\nRegistration Number: ${regNumber}\nEntry Fee: INR 50\nTournament Date: 21 November 2026\nMatch Time: 9:30 PM\n\nYour payment has been verified successfully. Thank you for participating!\n\nSARA SHADOWS SQUAD`
  });
}

module.exports = {
  verifyEmailConnection,
  sendAccountWelcomeEmail,
  sendTournamentRegistrationEmail,
  sendApprovalEmail
};
