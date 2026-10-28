/**
 * Telnet protocol helpers — RFC 854 framing + RFC 858/1091/1184/1408 options.
 *
 * The pieces live here so the protocol layer can be exercised by unit tests
 * without spinning up a socket. terminalBridge.cjs owns the policy (which
 * options to enable, what TERM-TYPE to advertise, how to wire data back to
 * the renderer), this module owns the parsing.
 */

// Command bytes (RFC 854 / RFC 855).
const IAC = 255;
const SE = 240;
const NOP = 241;
const DM = 242;
const BRK = 243;
const IP = 244;
const AO = 245;
const AYT = 246;
const EC = 247;
const EL = 248;
const GA = 249;
const SB = 250;
const WILL = 251;
const WONT = 252;
const DO = 253;
const DONT = 254;

// Options we care about. Servers may negotiate plenty of others, but we only
// surface these to the policy layer; everything else is rejected with DONT/
// WONT so the conversation terminates cleanly.
const OPT = {
  ECHO: 1,                 // RFC 857
  SUPPRESS_GO_AHEAD: 3,    // RFC 858
  STATUS: 5,
  TERMINAL_TYPE: 24,       // RFC 1091
  NAWS: 31,                // RFC 1073 — window size
  TERMINAL_SPEED: 32,
  LINEMODE: 34,
  NEW_ENVIRON: 39,
  COM_PORT: 44,            // RFC 2217 — Com Port Control Option
};

/**
 * RFC 2217 COM-PORT-OPTION sub-command bytes. Requests are 1..12; the server
 * answers `100 + request` on success and `200 + request` on failure.
 */
const COM_PORT = {
  SIGNATURE: 0,
  SET_BAUDRATE: 1,
  SET_DATASIZE: 2,
  SET_PARITY: 3,
  SET_STOPBITS: 4,
  SET_CONTROL: 5,
  NOTIFY_LINESTATE: 6,
  NOTIFY_MODEMSTATE: 7,
  FLOWCONTROL_SUSPEND: 8,
  FLOWCONTROL_RESUME: 9,
  SET_LINESTATE_MASK: 10,
  SET_MODEMSTATE_MASK: 11,
  PURGE_DATA: 12,
};

const COM_PORT_REQUEST_NAMES = {
  [COM_PORT.SIGNATURE]: "signature",
  [COM_PORT.SET_BAUDRATE]: "baudRate",
  [COM_PORT.SET_DATASIZE]: "dataBits",
  [COM_PORT.SET_PARITY]: "parity",
  [COM_PORT.SET_STOPBITS]: "stopBits",
  [COM_PORT.SET_CONTROL]: "flowControl",
  [COM_PORT.NOTIFY_LINESTATE]: "lineState",
  [COM_PORT.NOTIFY_MODEMSTATE]: "modemState",
  [COM_PORT.FLOWCONTROL_SUSPEND]: "flowSuspend",
  [COM_PORT.FLOWCONTROL_RESUME]: "flowResume",
  [COM_PORT.SET_LINESTATE_MASK]: "lineStateMask",
  [COM_PORT.SET_MODEMSTATE_MASK]: "modemStateMask",
  [COM_PORT.PURGE_DATA]: "purgeData",
};

// RFC 2217 §3 enumerations.
const COM_PORT_PARITY = { none: 1, odd: 2, even: 3, mark: 4, space: 5 };
const COM_PORT_DATASIZE = { 5: 5, 6: 6, 7: 7, 8: 8 };
const COM_PORT_STOPBITS = { 1: 1, 1.5: 3, 2: 2 };
// RFC 2217 §SET-CONTROL: 0 = none, 1 = XON/XOFF, 2 = RTS/CTS.
const COM_PORT_CONTROL = { none: 0, "xon/xoff": 1, "rts/cts": 2 };
// ser2net 3.x ignores the RFC values here and uses its own numbering
// (devcfg_control: 1 = none, 2 = XON/XOFF, 3 = RTS/CTS, 0 = leave alone), so a
// spec-correct "2" would turn into XON/XOFF there. Ask for the server
// signature first and encode accordingly instead of guessing.
const COM_PORT_CONTROL_SER2NET = { none: 1, "xon/xoff": 2, "rts/cts": 3 };
const COM_PORT_SIGNATURE_PROBE_MS = 300;

/**
 * Turn a line-settings object into the ordered list of COM-PORT-OPTION
 * subnegotiation payloads (each already starts with its command byte, ready
 * for `IAC SB 44 <payload> IAC SE`). Field order mirrors what a serial server
 * expects: baud first (it decides character timing), then framing, then flow
 * control.
 */
function buildComPortSetup(config, options = {}) {
  const cfg = config || {};
  const controlEncoding = options.controlEncoding || "rfc";
  const payloads = [];
  const baud = Number(cfg.baudRate);
  if (Number.isFinite(baud) && baud > 0) {
    const value = Math.min(Math.round(baud), 0xffffffff);
    payloads.push(Buffer.from([
      COM_PORT.SET_BAUDRATE,
      (value >>> 24) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 8) & 0xff,
      value & 0xff,
    ]));
  }
  const dataBits = COM_PORT_DATASIZE[cfg.dataBits];
  if (dataBits !== undefined) {
    payloads.push(Buffer.from([COM_PORT.SET_DATASIZE, dataBits]));
  }
  const parity = COM_PORT_PARITY[cfg.parity];
  if (parity !== undefined) {
    payloads.push(Buffer.from([COM_PORT.SET_PARITY, parity]));
  }
  const stopBits = COM_PORT_STOPBITS[cfg.stopBits];
  if (stopBits !== undefined) {
    payloads.push(Buffer.from([COM_PORT.SET_STOPBITS, stopBits]));
  }
  if (controlEncoding !== "none") {
    const table = controlEncoding === "ser2net" ? COM_PORT_CONTROL_SER2NET : COM_PORT_CONTROL;
    const control = table[cfg.flowControl];
    if (control !== undefined) {
      payloads.push(Buffer.from([COM_PORT.SET_CONTROL, control]));
    }
  }
  return payloads;
}

/** The SET-CONTROL payload alone, for the post-signature path. */
function buildComPortControlPayload(config, controlEncoding = "rfc") {
  const table = controlEncoding === "ser2net" ? COM_PORT_CONTROL_SER2NET : COM_PORT_CONTROL;
  const value = table[config?.flowControl];
  return value === undefined ? null : Buffer.from([COM_PORT.SET_CONTROL, value]);
}

// Server -> client reply codes. 100..112 is NOT a straight `request + 100`:
// RFC 2217 puts the two NOTIFY-* messages (106/107) and the flow-control
// suspend/resume pair (108/109) in the same range as the acknowledgements, so
// the table has to be explicit or a modem-state notification reads as an ack.
const COM_PORT_REPLY_KIND = {
  100: { kind: "ack", field: "signature" },
  101: { kind: "ack", field: "baudRate" },
  102: { kind: "ack", field: "dataBits" },
  103: { kind: "ack", field: "parity" },
  104: { kind: "ack", field: "stopBits" },
  105: { kind: "ack", field: "flowControl" },
  106: { kind: "notify", field: "lineState" },
  107: { kind: "notify", field: "modemState" },
  108: { kind: "notify", field: "flowSuspend" },
  109: { kind: "notify", field: "flowResume" },
  110: { kind: "ack", field: "lineStateMask" },
  111: { kind: "ack", field: "modemStateMask" },
  112: { kind: "ack", field: "purgeData" },
};

/** Compact 8N1-style label for logs and user-visible notices. */
function describeComPortConfig(config) {
  const cfg = config || {};
  const parity = { none: "N", odd: "O", even: "E", mark: "M", space: "S" }[cfg.parity] || "?";
  return `${cfg.baudRate} ${cfg.dataBits}${parity}${cfg.stopBits}`;
}

/**
 * Decode a COM-PORT-OPTION subnegotiation coming from the server.
 *
 *   unsigned char   client requests (a server never sends these)
 *   100..112        acknowledgements / notifications
 *   200..212        failures, one per request byte
 *
 * Returns `{ kind: 'ack' | 'error' | 'notify', field, code, request, value? }`
 * so the session can tell the user which setting the remote rejected.
 */
function decodeComPortPayload(payload) {
  if (!payload || payload.length === 0) return null;
  const code = payload[0];

  // Errors are 200 + the request byte (201 SET-BAUDRATE ... 212 PURGE-DATA).
  if (code >= 200 && code < 300) {
    const request = code - 200;
    return {
      kind: "error",
      code,
      request,
      field: COM_PORT_REQUEST_NAMES[request] || `request-${request}`,
    };
  }

  const reply = COM_PORT_REPLY_KIND[code];
  if (!reply) return { kind: "notify", code, request: code, field: `code-${code}` };

  if (reply.kind === "ack") {
    let value;
    if (code === 100) {
      value = payload.subarray(1).toString("latin1"); // server signature string
    } else if (code === 101 && payload.length >= 5) {
      value = ((payload[1] << 24) | (payload[2] << 16) | (payload[3] << 8) | payload[4]) >>> 0;
    } else if (payload.length >= 2) {
      value = payload[1];
    }
    return { kind: "ack", code, request: code - 100, field: reply.field, value };
  }
  return { kind: reply.kind, code, request: code - 100, field: reply.field };
}

const SUBOPTION_IS = 0;
const SUBOPTION_SEND = 1;

const isOptionCommand = (cmd) =>
  cmd === WILL || cmd === WONT || cmd === DO || cmd === DONT;

const commandName = (cmd) => {
  switch (cmd) {
    case IAC: return "IAC";
    case SE: return "SE";
    case NOP: return "NOP";
    case DM: return "DM";
    case BRK: return "BRK";
    case IP: return "IP";
    case AO: return "AO";
    case AYT: return "AYT";
    case EC: return "EC";
    case EL: return "EL";
    case GA: return "GA";
    case SB: return "SB";
    case WILL: return "WILL";
    case WONT: return "WONT";
    case DO: return "DO";
    case DONT: return "DONT";
    default: return String(cmd);
  }
};

/**
 * Escape a buffer for wire transmission: any literal 0xFF byte becomes
 * 0xFF 0xFF so the peer's parser does not treat it as IAC. Cheap fast-path
 * for the common case (no 0xFF bytes) so user typing — which is UTF-8 and
 * cannot contain 0xFF — pays nothing.
 */
function escapeIacForWire(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return buf;
  if (buf.indexOf(0xff) < 0) return buf;
  const out = [];
  for (let i = 0; i < buf.length; i++) {
    out.push(buf[i]);
    if (buf[i] === 0xff) out.push(0xff);
  }
  return Buffer.from(out);
}

/**
 * Normalize text input to Telnet NVT newline rules (RFC 854): newline is CR LF,
 * while a literal carriage return is CR NUL. Existing CR LF / CR NUL sequences
 * are already valid and must not be expanded again.
 */
function normalizeNvtNewlines(data) {
  if (typeof data !== "string" || data.length === 0) return data;
  return data
    .replace(/\r(?![\n\0])/g, "\r\n")
    .replace(/(?<!\r)\n/g, "\r\n");
}

/**
 * Build a stateful Telnet parser.
 *
 * The parser preserves any partial command (IAC alone, IAC + verb without
 * option, or unterminated subnegotiation) between feeds so that a sequence
 * split across TCP frames is reassembled before being acted on. The previous
 * stateless approach would either drop the lone IAC or treat the tail of an
 * unterminated SB block as data — exactly the source of the garbled-output
 * symptom on chatty old equipment.
 *
 * Callbacks:
 *   onCommand(cmd, opt)        — WILL/WONT/DO/DONT for `opt`.
 *   onSubnegotiation(opt, buf) — IAC SB <opt> ... IAC SE. `buf` is the
 *                                 payload between option byte and IAC SE,
 *                                 with any IAC IAC unescaped to a single
 *                                 0xFF.
 *   onData(buf)                — clean stream bytes, IAC IAC already
 *                                 unescaped. Emitted in chunks coinciding
 *                                 with command boundaries; never empty.
 */
function createTelnetParser({ onCommand, onSubnegotiation, onData } = {}) {
  let pending = Buffer.alloc(0);

  const noop = () => {};
  const handleCommand = typeof onCommand === "function" ? onCommand : noop;
  const handleSubnegotiation = typeof onSubnegotiation === "function" ? onSubnegotiation : noop;
  const handleData = typeof onData === "function" ? onData : noop;

  const feed = (chunk) => {
    if (!chunk || chunk.length === 0) return;
    const buf = pending.length === 0
      ? (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      : Buffer.concat([pending, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    pending = Buffer.alloc(0);

    const out = [];
    let i = 0;
    const flushData = () => {
      if (out.length > 0) {
        handleData(Buffer.from(out));
        out.length = 0;
      }
    };

    while (i < buf.length) {
      const byte = buf[i];
      if (byte !== IAC) {
        out.push(byte);
        i++;
        continue;
      }

      // We are at an IAC byte. Need at least one more byte to know the verb.
      if (i + 1 >= buf.length) {
        pending = buf.subarray(i);
        break;
      }

      const cmd = buf[i + 1];

      if (cmd === IAC) {
        // Escaped literal 0xFF in the data stream.
        out.push(0xff);
        i += 2;
        continue;
      }

      if (isOptionCommand(cmd)) {
        if (i + 2 >= buf.length) {
          pending = buf.subarray(i);
          break;
        }
        const opt = buf[i + 2];
        flushData();
        handleCommand(cmd, opt);
        i += 3;
        continue;
      }

      if (cmd === SB) {
        // Subnegotiation: IAC SB <opt> <payload...> IAC SE. We need to find
        // the terminating IAC SE while ignoring escaped IAC IAC inside the
        // payload (RFC 855).
        let j = i + 3;
        let seFound = false;
        while (j + 1 < buf.length) {
          if (buf[j] === IAC) {
            if (buf[j + 1] === SE) {
              seFound = true;
              break;
            }
            // Escaped IAC IAC in payload, or another IAC verb (rare,
            // ignored). Either way, skip two bytes and keep scanning.
            j += 2;
            continue;
          }
          j++;
        }
        if (!seFound) {
          // Subnegotiation continues into the next frame.
          pending = buf.subarray(i);
          break;
        }
        if (i + 2 >= buf.length) {
          pending = buf.subarray(i);
          break;
        }
        const opt = buf[i + 2];
        const rawPayload = buf.subarray(i + 3, j);
        const payload = unescapeIacFromPayload(rawPayload);
        flushData();
        handleSubnegotiation(opt, payload);
        i = j + 2;
        continue;
      }

      // Other single-verb IAC commands (NOP, AYT, IP, ...). The protocol
      // does not require us to act, but we must still consume the two bytes
      // so they do not leak into the data stream.
      flushData();
      i += 2;
    }

    flushData();
  };

  return {
    feed,
    get pendingByteCount() {
      return pending.length;
    },
    /** Reset state — used when a session is torn down or reconnected. */
    reset() {
      pending = Buffer.alloc(0);
    },
  };
}

function unescapeIacFromPayload(buf) {
  if (!buf || buf.indexOf(0xff) < 0) return buf;
  const out = [];
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0xff && i + 1 < buf.length && buf[i + 1] === 0xff) {
      out.push(0xff);
      i++;
      continue;
    }
    out.push(buf[i]);
  }
  return Buffer.from(out);
}

/**
 * Build a Telnet negotiation policy machine.
 *
 * The machine owns the rules for which options we accept, the
 * direction-aware acknowledgement tracking, and the wire bytes sent in
 * response to peer commands. It is intentionally separated from socket I/O
 * so it can be exercised directly in unit tests.
 *
 * `writeCommand(cmd, opt)` is invoked to send `IAC <cmd> <opt>` on the
 * wire; `writeSubnegotiation(opt, payload)` is invoked to send
 * `IAC SB <opt> <payload...> IAC SE` (with `payload` already escaped if
 * needed by the caller); `getWindowSize()` returns `{ cols, rows }` for
 * the current terminal dimensions; `termType` is the string advertised
 * for TERMINAL-TYPE subnegotiation (default "XTERM-256COLOR").
 */
function createTelnetNegotiator({
  writeCommand,
  writeSubnegotiation,
  getWindowSize,
  termType = "XTERM-256COLOR",
  onRemoteEchoChange,
  onLocalEchoChange,
  comPort = null,
  onComPortStatus,
} = {}) {
  const pendingDoRequests = new Set();
  const pendingWillRequests = new Set();
  const enabledRemoteOptions = new Set();
  const enabledLocalOptions = new Set();

  const noopWrite = () => {};
  const cmdSink = typeof writeCommand === "function" ? writeCommand : noopWrite;
  const sbSink = typeof writeSubnegotiation === "function" ? writeSubnegotiation : noopWrite;
  const sizeFn = typeof getWindowSize === "function"
    ? getWindowSize
    : () => ({ cols: 80, rows: 24 });
  const echoSink = typeof onRemoteEchoChange === "function" ? onRemoteEchoChange : () => {};
  const localEchoSink = typeof onLocalEchoChange === "function" ? onLocalEchoChange : () => {};
  const comPortSink = typeof onComPortStatus === "function" ? onComPortStatus : () => {};
  // RFC 2217 mode: the peer is a serial server, not a login service. Window
  // size and terminal type are irrelevant there — negotiate the COM port only.
  const comPortConfig = comPort && comPort.enabled !== false ? comPort : null;
  // Line settings go out immediately; SET-CONTROL waits for the signature
  // because ser2net numbers its flow-control values differently from RFC 2217.
  const comPortBasePayloads = comPortConfig
    ? buildComPortSetup(comPortConfig, { controlEncoding: "none" })
    : [];
  let comPortSent = false;
  let comPortControlSent = false;
  let comPortControlTimer = null;

  const sendComPortControl = (encoding) => {
    if (!comPortConfig || comPortControlSent) return;
    comPortControlSent = true;
    if (comPortControlTimer) {
      clearTimeout(comPortControlTimer);
      comPortControlTimer = null;
    }
    const payload = buildComPortControlPayload(comPortConfig, encoding);
    if (payload) sbSink(OPT.COM_PORT, payload);
  };

  const enableComPort = () => {
    if (!comPortConfig || comPortSent) return;
    comPortSent = true;
    for (const payload of comPortBasePayloads) sbSink(OPT.COM_PORT, payload);
    comPortSink({ state: "negotiated", config: { ...comPortConfig } });
    // Ask who owns the port so SET-CONTROL uses its native numbering; if the
    // answer never comes, fall back to the RFC values.
    sbSink(OPT.COM_PORT, Buffer.from([COM_PORT.SIGNATURE]));
    comPortControlTimer = setTimeout(
      () => sendComPortControl("rfc"),
      COM_PORT_SIGNATURE_PROBE_MS,
    );
    if (comPortControlTimer && typeof comPortControlTimer.unref === "function") {
      comPortControlTimer.unref();
    }
  };

  const naws = () => {
    if (!enabledLocalOptions.has(OPT.NAWS)) return false;
    const { cols, rows } = sizeFn() || {};
    const safeCols = Number.isFinite(cols) && cols > 0 ? cols : 80;
    const safeRows = Number.isFinite(rows) && rows > 0 ? rows : 24;
    const payload = Buffer.from([
      (safeCols >> 8) & 0xff, safeCols & 0xff,
      (safeRows >> 8) & 0xff, safeRows & 0xff,
    ]);
    sbSink(OPT.NAWS, escapeIacForWire(payload));
    return true;
  };

  const sendTerminalType = () => {
    sbSink(
      OPT.TERMINAL_TYPE,
      Buffer.concat([
        Buffer.from([SUBOPTION_IS]),
        Buffer.from(String(termType), "ascii"),
      ]),
    );
  };

  const requestOption = (cmd, opt) => {
    if (cmd === DO) pendingDoRequests.add(opt);
    else if (cmd === WILL) pendingWillRequests.add(opt);
    cmdSink(cmd, opt);
  };

  const start = () => {
    // Drive the negotiation rather than waiting for the peer. Many legacy
    // servers will not advance past their banner until the client commits
    // to a basic option set.
    requestOption(DO, OPT.SUPPRESS_GO_AHEAD);
    if (comPortConfig) {
      // RFC 2217 in practice (ser2net, pyserial): the *client* offers WILL
      // COM-PORT-OPTION and waits for the server's DO before sending the
      // SET-* subnegotiations.
      requestOption(WILL, OPT.COM_PORT);
      return;
    }
    requestOption(WILL, OPT.TERMINAL_TYPE);
    requestOption(WILL, OPT.NAWS);
  };

  const handleCommand = (cmd, opt) => {
    let acknowledgesOurRequest = false;
    if ((cmd === WILL || cmd === WONT) && pendingDoRequests.has(opt)) {
      pendingDoRequests.delete(opt);
      acknowledgesOurRequest = true;
    } else if ((cmd === DO || cmd === DONT) && pendingWillRequests.has(opt)) {
      pendingWillRequests.delete(opt);
      acknowledgesOurRequest = true;
    }

    if (cmd === WILL) {
      const supported = opt === OPT.SUPPRESS_GO_AHEAD || opt === OPT.ECHO;
      const wasEnabled = enabledRemoteOptions.has(opt);
      if (supported) enabledRemoteOptions.add(opt);
      if (opt === OPT.ECHO) {
        echoSink(true);
        if (enabledLocalOptions.delete(opt)) {
          localEchoSink(false);
          cmdSink(WONT, opt);
        }
      }
      if (!acknowledgesOurRequest) {
        if (supported && !wasEnabled) {
          cmdSink(DO, opt);
        } else if (!supported) {
          cmdSink(DONT, opt);
        }
      }
      return;
    }

    if (cmd === DO) {
      const wasEnabled = enabledLocalOptions.has(opt);
      if (opt === OPT.COM_PORT) {
        enabledLocalOptions.add(opt);
        if (!acknowledgesOurRequest && !wasEnabled) cmdSink(WILL, opt);
        enableComPort();
        return;
      }
      if (opt === OPT.NAWS) {
        enabledLocalOptions.add(opt);
        if (!acknowledgesOurRequest && !wasEnabled) cmdSink(WILL, opt);
        // Follow through with the actual size when NAWS first becomes active,
        // whether this DO acknowledges our WILL or starts from the peer.
        if (!wasEnabled) naws();
      } else if (opt === OPT.ECHO) {
        enabledLocalOptions.add(opt);
        if (!acknowledgesOurRequest && !wasEnabled) cmdSink(WILL, opt);
        if (!wasEnabled) localEchoSink(true);
      } else if (opt === OPT.TERMINAL_TYPE || opt === OPT.SUPPRESS_GO_AHEAD) {
        enabledLocalOptions.add(opt);
        if (!acknowledgesOurRequest && !wasEnabled) cmdSink(WILL, opt);
      } else {
        if (!acknowledgesOurRequest) cmdSink(WONT, opt);
      }
      return;
    }

    if (cmd === DONT) {
      const wasEnabled = enabledLocalOptions.delete(opt);
      if (opt === OPT.ECHO && wasEnabled) localEchoSink(false);
      if (!acknowledgesOurRequest && (wasEnabled || pendingWillRequests.has(opt))) {
        cmdSink(WONT, opt);
      }
      return;
    }

    if (cmd === WONT) {
      const wasEnabled = enabledRemoteOptions.delete(opt);
      if (opt === OPT.ECHO) echoSink(false);
      if (opt === OPT.COM_PORT && comPortConfig) {
        // The endpoint is not an RFC 2217 serial server: the session still
        // works as a plain telnet login, the line settings simply stay put.
        comPortSink({ state: "unsupported", config: { ...comPortConfig } });
      }
      if (!acknowledgesOurRequest && wasEnabled) cmdSink(DONT, opt);
      return;
    }
  };

  const handleSubnegotiation = (opt, payload) => {
    if (opt === OPT.TERMINAL_TYPE
      && payload && payload.length > 0
      && payload[0] === SUBOPTION_SEND) {
      sendTerminalType();
      return;
    }
    if (opt === OPT.COM_PORT && comPortConfig) {
      const decoded = decodeComPortPayload(payload);
      if (!decoded) return;
      if (decoded.kind === "error") {
        comPortSink({
          state: "rejected",
          field: decoded.field,
          code: decoded.code,
          config: { ...comPortConfig },
        });
        return;
      }
      if (decoded.kind === "ack") {
        if (decoded.code === 100) {
          // Signature reply: pick the SET-CONTROL numbering and send it now.
          const isSer2net = /ser2net/i.test(String(decoded.value || ""));
          sendComPortControl(isSer2net ? "ser2net" : "rfc");
          return;
        }
        comPortSink({
          state: "applied",
          field: decoded.field,
          value: decoded.value,
          config: { ...comPortConfig },
        });
      }
    }
  };

  return {
    start,
    handleCommand,
    handleSubnegotiation,
    sendWindowSize: naws,
    /** Test/debug introspection — number of options awaiting a reply per direction. */
    get pendingDoCount() {
      return pendingDoRequests.size;
    },
    get pendingWillCount() {
      return pendingWillRequests.size;
    },
  };
}

module.exports = {
  // Command constants
  IAC,
  SE,
  NOP,
  DM,
  BRK,
  IP,
  AO,
  AYT,
  EC,
  EL,
  GA,
  SB,
  WILL,
  WONT,
  DO,
  DONT,
  // Options
  OPT,
  // RFC 2217 COM-PORT-OPTION
  COM_PORT,
  SUBOPTION_IS,
  SUBOPTION_SEND,
  // Helpers
  commandName,
  escapeIacForWire,
  normalizeNvtNewlines,
  createTelnetParser,
  createTelnetNegotiator,
  buildComPortSetup,
  buildComPortControlPayload,
  decodeComPortPayload,
  describeComPortConfig,
};
