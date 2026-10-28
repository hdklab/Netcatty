const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");

const terminalBridge = require("./terminalBridge.cjs");
const { IAC, SB, SE, WILL, WONT, DO, OPT } = require("./telnetProtocol.cjs");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

function waitFor(predicate, timeoutMs = 2000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error("Timed out waiting for the RFC 2217 handshake"));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

/** Split a raw client stream into telnet commands and COM-PORT subnegotiations. */
function parseFrames(buffer) {
  const frames = [];
  let i = 0;
  while (i < buffer.length) {
    if (buffer[i] !== IAC) {
      i += 1;
      continue;
    }
    const verb = buffer[i + 1];
    if (verb === WILL || verb === WONT || verb === DO || verb === DONT_VERB()) {
      frames.push({ type: "cmd", verb, opt: buffer[i + 2] });
      i += 3;
      continue;
    }
    if (verb === SB) {
      const opt = buffer[i + 2];
      const end = buffer.indexOf(Buffer.from([IAC, SE]), i + 3);
      if (end < 0) break;
      frames.push({ type: "sb", opt, payload: [...buffer.subarray(i + 3, end)] });
      i = end + 2;
      continue;
    }
    i += 2;
  }
  return frames;
}

const DONT_VERB = () => 254;

async function runHandshake({ replyToWill, ack, config, greet = false }) {
  const received = Buffer.alloc(0);
  const chunks = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    if (greet) {
      // A plain telnet host only negotiates after the peer speaks first; the
      // client's lazy activation is what this case exercises.
      setImmediate(() => socket.write(Buffer.from([IAC, WILL, OPT.ECHO])));
    }
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      const all = Buffer.concat(chunks);
      // Answer the WILL COM-PORT offer exactly once.
      if (replyToWill && all.includes(Buffer.from([IAC, WILL, OPT.COM_PORT])) && !socket.__answered) {
        socket.__answered = true;
        socket.write(Buffer.from([IAC, replyToWill, OPT.COM_PORT]));
      }
      if (ack) {
        const frames = parseFrames(all);
        const baud = frames.find((frame) => frame.type === "sb" && frame.payload[0] === 1);
        if (baud && !socket.__acked) {
          socket.__acked = true;
          socket.write(Buffer.from([
            IAC, SB, OPT.COM_PORT, 101, ...baud.payload.slice(1, 5), IAC, SE,
          ]));
        }
        const signatureProbe = frames.find((frame) => frame.type === "sb" && frame.payload[0] === 0);
        if (signatureProbe && !socket.__signed) {
          socket.__signed = true;
          socket.write(Buffer.concat([
            Buffer.from([IAC, SB, OPT.COM_PORT, 100]),
            Buffer.from("ser2net", "latin1"),
            Buffer.from([IAC, SE]),
          ]));
        }
      }
    });
  });

  const port = await listen(server);
  const sessionId = `telnet-serial-test-${Math.random().toString(16).slice(2)}`;
  const sentEvents = [];
  terminalBridge.init({
    sessions: new Map(),
    electronModule: {
      webContents: {
        fromId: () => ({
          send(channel, payload) {
            sentEvents.push({ channel, payload });
          },
        }),
      },
    },
  });

  try {
    await terminalBridge.startTelnetSession(
      { sender: { id: 1 } },
      { sessionId, hostname: "127.0.0.1", port, telnetSerial: config },
    );
    // Wait for the client's first bytes, then for the handshake to settle: the
    // `applied` ack arrives one round-trip after `negotiated`.
    await waitFor(() => chunks.length > 0);
    if (config) {
      await waitFor(() => sentEvents.some(
        (evt) => evt.channel === "netcatty:telnet:serial-status" && evt.payload.state !== "negotiated",
      ));
    }
    // SET-CONTROL arrives after the signature round trip.
    await waitFor(
      () => parseFrames(Buffer.concat(chunks)).some(
        (frame) => frame.type === "sb" && frame.payload[0] === 5,
      ),
      1500,
    ).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 100));
    return {
      sessionId,
      frames: parseFrames(Buffer.concat(chunks)),
      channels: sentEvents.filter((evt) => evt.channel === "netcatty:telnet:serial-status"),
      raw: received,
    };
  } finally {
    terminalBridge.cleanupAllSessions();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

const SERIAL = {
  enabled: true,
  baudRate: 9600,
  dataBits: 7,
  parity: "even",
  stopBits: 2,
  flowControl: "rts/cts",
};

test("Telnet serial host offers RFC 2217 and sends the line settings after DO", async () => {
  const { sessionId, frames, channels } = await runHandshake({ replyToWill: DO, ack: true, config: SERIAL });

  const will = frames.find((frame) => frame.type === "cmd" && frame.verb === WILL);
  assert.equal(will?.opt, OPT.COM_PORT, "client must offer WILL COM-PORT-OPTION");

  const subnegs = frames.filter((frame) => frame.type === "sb" && frame.opt === OPT.COM_PORT);
  const lineSettings = subnegs.filter((frame) => frame.payload[0] !== 0 && frame.payload[0] !== 5);
  assert.deepEqual(lineSettings.map((frame) => frame.payload), [
    [1, 0x00, 0x00, 0x25, 0x80], // 9600
    [2, 7],
    [3, 3], // even
    [4, 2],
  ]);
  // ser2net answered the signature probe, so SET-CONTROL uses its numbering:
  // 3 = RTS/CTS there, where RFC 2217 would say 2.
  const control = subnegs.find((frame) => frame.payload[0] === 5);
  assert.deepEqual(control?.payload, [5, 3]);

  assert.equal(channels[0].payload.state, "negotiated");
  assert.equal(channels[0].payload.sessionId, sessionId);
  const applied = channels.find((evt) => evt.payload.state === "applied");
  assert.equal(applied?.payload.field, "baudRate");
  assert.equal(applied?.payload.value, 9600);
});

test("a plain telnet host never offers COM-PORT-OPTION", async () => {
  const { frames, channels } = await runHandshake({ replyToWill: DO, ack: true, config: undefined, greet: true });
  assert.equal(frames.some((frame) => frame.type === "cmd" && frame.opt === OPT.COM_PORT), false);
  assert.equal(frames.some((frame) => frame.type === "sb" && frame.opt === OPT.COM_PORT), false);
  assert.equal(channels.length, 0);
});

test("an endpoint that refuses COM-PORT-OPTION reports unsupported and stays usable", async () => {
  const { frames, channels } = await runHandshake({ replyToWill: WONT, ack: true, config: SERIAL });
  assert.equal(channels.at(-1)?.payload.state, "unsupported");
  assert.equal(frames.some((frame) => frame.type === "sb" && frame.opt === OPT.COM_PORT), false);
});
