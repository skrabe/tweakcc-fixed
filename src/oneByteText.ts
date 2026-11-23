const NON_LATIN1 = /[\u0100-\uffff]/;

export const oneByteText = (text: string): string =>
  NON_LATIN1.test(text) ? text : Buffer.from(text, 'latin1').toString('latin1');
