/** Type shim for pdf-parse (ships no types). */
declare module "pdf-parse" {
  export interface PdfInfo {
    Title?: string;
    Author?: string;
    [key: string]: unknown;
  }
  export interface PdfResult {
    numpages: number;
    numrender: number;
    info: PdfInfo;
    metadata: unknown;
    text: string;
    version: string;
  }
  export default function pdfParse(
    dataBuffer: Buffer | Uint8Array,
    options?: Record<string, unknown>,
  ): Promise<PdfResult>;
}
