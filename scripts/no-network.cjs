// External enforcement of "nothing is uploaded": a Node preload that turns any
// outbound network attempt into a thrown error, installed BEFORE mendr's own
// code runs. Use it to prove, on your machine, that the default audit needs no
// network at all:
//
//   NODE_OPTIONS="--require /path/to/scripts/no-network.cjs" npx mendr audit . --json
//
// The test suite runs exactly this around the default audit on every build
// (src/audit/noNetwork.test.ts), and separately proves the guard bites by
// attempting the optional provider read under it.
'use strict';
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const dns = require('node:dns');

const MSG = 'no-network preload: outbound network access is blocked in this process';
const block = (op) => () => {
  const e = new Error(`${MSG} (blocked: ${op})`);
  e.name = 'OfflineViolation';
  throw e;
};

globalThis.fetch = async (input) => {
  const target = typeof input === 'string' ? input : input && input.href ? input.href : 'fetch';
  const e = new Error(`${MSG} (blocked: fetch ${String(target).slice(0, 120)})`);
  e.name = 'OfflineViolation';
  throw e;
};
http.request = block('http.request');
http.get = block('http.get');
https.request = block('https.request');
https.get = block('https.get');
// Local IPC (named pipes / unix sockets, e.g. a tool runner talking to its
// parent process) is not the network. Only TCP connections are blocked.
const originalCreateConnection = net.createConnection;
const isIpc = (a) =>
  (typeof a === 'string' && !/^\d+$/.test(a)) ||
  (a !== null && typeof a === 'object' && typeof a.path === 'string' && a.port === undefined);
const guardedConnect = function (...args) {
  if (isIpc(args[0])) return originalCreateConnection.apply(net, args);
  return block('net.connect')();
};
net.connect = guardedConnect;
net.createConnection = guardedConnect;
tls.connect = block('tls.connect');
dns.lookup = block('dns.lookup');
dns.resolve = block('dns.resolve');
dns.resolve4 = block('dns.resolve4');
dns.resolve6 = block('dns.resolve6');
dns.promises.lookup = block('dns.promises.lookup');
dns.promises.resolve = block('dns.promises.resolve');
