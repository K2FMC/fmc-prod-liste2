function getImageDimensions(buffer, ext) {
  try {
    if (ext === 'png') {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    // JPEG — cherche le marqueur SOF0/SOF1/SOF2
    let i = 2;
    while (i < buffer.length - 9) {
      if (buffer[i] !== 0xFF) break;
      const marker = buffer[i + 1];
      if (marker === 0xC0 || marker === 0xC1 || marker === 0xC2) {
        return { width: buffer.readUInt16BE(i + 7), height: buffer.readUInt16BE(i + 5) };
      }
      i += 2 + buffer.readUInt16BE(i + 2);
    }
  } catch (_) {}
  return null;
}

module.exports = { getImageDimensions };
