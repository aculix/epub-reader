// Central pdf.js loader — imported dynamically so the library page doesn't pay
// for pdf.js unless a PDF is actually opened or uploaded.
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export default pdfjs;
