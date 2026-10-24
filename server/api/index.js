'use strict';

const app = require('../index.js');

// Vercel invokes a callable (req, res) handler; a raw http.Server is not one.
// Disable framework body parsing so Razorpay signs the exact webhook bytes.
const handler = (req, res) => app.emit('request', req, res);
handler.config = { api: { bodyParser: false } };

module.exports = handler;
