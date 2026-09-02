/**
 * Minimal RFC 6455 server-side WebSocket, so the bridge stays dependency-free.
 * Only what this project needs: a text channel, ping/pong and clean closes.
 */
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

function encodeFrame(payload, opcode = 0x1) {
  const body = Buffer.from(payload);
  const length = body.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, body]);
}

export class WsConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.closed = false;

    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
    socket.on('close', () => this.finish());
    socket.on('error', () => this.finish());
  }

  drain() {
    // Frames can arrive coalesced or split; loop until the buffer is short.
    for (;;) {
      if (this.buffer.length < 2) return;
      const first = this.buffer[0];
      const second = this.buffer[1];
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        length = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }

      let mask = null;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        mask = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (this.buffer.length < offset + length) return;

      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
      this.buffer = this.buffer.subarray(offset + length);

      if (opcode === 0x8) {
        this.close();
        return;
      }
      if (opcode === 0x9) {
        this.socket.write(encodeFrame(payload, 0xa));
        continue;
      }
      if (opcode === 0x1 || opcode === 0x0) this.emit('message', payload.toString('utf8'));
    }
  }

  send(text) {
    if (this.closed) return false;
    try {
      this.socket.write(encodeFrame(text, 0x1));
      return true;
    } catch {
      this.finish();
      return false;
    }
  }

  ping() {
    if (this.closed) return;
    try {
      this.socket.write(encodeFrame('', 0x9));
    } catch {
      this.finish();
    }
  }

  close() {
    if (this.closed) return;
    try {
      this.socket.write(encodeFrame('', 0x8));
      this.socket.end();
    } catch {
      /* already gone */
    }
    this.finish();
  }

  finish() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
}

/** Completes the HTTP upgrade handshake and returns a live connection. */
export function upgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return null;
  }
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey(key)}`,
      '\r\n',
    ].join('\r\n'),
  );
  socket.setNoDelay(true);
  return new WsConnection(socket);
}
