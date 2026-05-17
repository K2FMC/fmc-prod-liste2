const { getImageDimensions } = require('../../lib/imageUtils');

function makePngBuffer(width, height) {
  const buf = Buffer.alloc(24);
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

// Buffer JPEG minimal : SOF directement en position 2
function makeJpegBuffer(width, height, marker = 0xC0) {
  const buf = Buffer.alloc(20);
  buf[2] = 0xFF;
  buf[3] = marker;
  buf.writeUInt16BE(height, 7);
  buf.writeUInt16BE(width, 9);
  return buf;
}

describe('getImageDimensions — PNG', () => {
  it('retourne les dimensions correctes', () => {
    expect(getImageDimensions(makePngBuffer(800, 600), 'png')).toEqual({ width: 800, height: 600 });
  });

  it('fonctionne pour une image 1×1', () => {
    expect(getImageDimensions(makePngBuffer(1, 1), 'png')).toEqual({ width: 1, height: 1 });
  });

  it('retourne null si le buffer est trop court', () => {
    expect(getImageDimensions(Buffer.alloc(8), 'png')).toBeNull();
  });
});

describe('getImageDimensions — JPEG', () => {
  it('retourne les dimensions avec marqueur SOF0 (0xC0)', () => {
    expect(getImageDimensions(makeJpegBuffer(1200, 900, 0xC0), 'jpeg')).toEqual({ width: 1200, height: 900 });
  });

  it('retourne les dimensions avec marqueur SOF1 (0xC1)', () => {
    expect(getImageDimensions(makeJpegBuffer(640, 480, 0xC1), 'jpeg')).toEqual({ width: 640, height: 480 });
  });

  it('retourne les dimensions avec marqueur SOF2 (0xC2)', () => {
    expect(getImageDimensions(makeJpegBuffer(320, 240, 0xC2), 'jpeg')).toEqual({ width: 320, height: 240 });
  });

  it('retourne null si le buffer est trop court', () => {
    expect(getImageDimensions(Buffer.alloc(10), 'jpeg')).toBeNull();
  });

  it('retourne null si le premier octet en position 2 n\'est pas 0xFF', () => {
    const buf = Buffer.alloc(20);
    buf[2] = 0x00; // invalide
    expect(getImageDimensions(buf, 'jpeg')).toBeNull();
  });

  it('retourne null pour un buffer vide', () => {
    expect(getImageDimensions(Buffer.alloc(0), 'jpeg')).toBeNull();
  });
});
