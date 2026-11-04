/**
 * pdf.js for the Files pane, loaded the first time a PDF is opened so the
 * session page does not carry it until then. It draws the pages itself because
 * a browser's own PDF viewer is not there to lean on: Chrome on Android shows
 * none inside a page at all.
 */
import type { PDFDocumentLoadingTask } from 'pdfjs-dist';

/** Handed over as its loading task, so that leaving a PDF can stop the load as well as the document. */
export async function openPdf(url: string): Promise<PDFDocumentLoadingTask> {
	// The legacy build: the modern one calls JavaScript too new for the phones this is here for.
	const [pdfjs, worker] = await Promise.all([
		import('pdfjs-dist/legacy/build/pdf.mjs'),
		import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')
	]);
	pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
	// What scanned images, CJK text and fonts the file does not embed need; `vite.config.ts` puts them here.
	return pdfjs.getDocument({
		url,
		wasmUrl: '/pdfjs/wasm/',
		cMapUrl: '/pdfjs/cmaps/',
		standardFontDataUrl: '/pdfjs/standard_fonts/',
		iccUrl: '/pdfjs/iccs/'
	});
}
