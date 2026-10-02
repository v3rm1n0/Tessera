/** The classic-script libraries, each setting a global; views load them when they need them. */
const SOURCES = {
  jsqr: '/vendor/jsQR.js',               // window.jsQR  (the scanner)
  jszip: '/vendor/jszip.js',             // window.JSZip (the card export)
  qrcode: '/vendor/qrcode-generator.js', // window.qrcode (the card preview and export)
};

const loads = new WeakMap(); // document -> Map(name -> promise)

/**
 * Loads a vendor script once per document: the same promise is handed out while it loads and after,
 * a failed load can be retried. Rejects when the file cannot be fetched; throws for an unknown name.
 */
export function loadVendor(name, doc = document) {
  if (!Object.hasOwn(SOURCES, name)) throw new Error(`Unknown vendor script: ${name}`);
  if (!loads.has(doc)) loads.set(doc, new Map());
  const mine = loads.get(doc);
  if (!mine.has(name)) {
    mine.set(name, new Promise((resolve, reject) => {
      const script = doc.createElement('script');
      script.src = SOURCES[name];
      script.async = true;
      script.addEventListener('load', () => resolve());
      script.addEventListener('error', () => {
        mine.delete(name); // a later call tries again
        script.remove();
        reject(new Error(`Could not load ${SOURCES[name]}`));
      });
      doc.head.append(script);
    }));
  }
  return mine.get(name);
}
