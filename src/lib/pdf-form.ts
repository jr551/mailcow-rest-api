// Lightweight wrapper around pdf-lib for detecting + filling AcroForm
// fields in PDF attachments. Used by MessageDetail to show a "fill this
// form here" banner and by PdfFormFiller to do the actual editing.

import { PDFDocument, PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown } from 'pdf-lib';

export type FieldKind = 'text' | 'checkbox' | 'radio' | 'dropdown' | 'unknown';

export interface PdfFormField {
    name: string;
    kind: FieldKind;
    /** Current value (string for text/dropdown/radio, boolean for checkbox). */
    value: string | boolean;
    /** Available options for dropdown / radio. */
    options?: string[];
    /** Hint pulled from the field's name — best-effort label until we can
     *  read /TU (tooltip / user-facing name) reliably. */
    label: string;
}

/** Cheap detector: load + count form fields. Returns true even when the
 *  PDF declares /AcroForm but has zero fields (rare but possible). */
export async function hasPdfForm(bytes: ArrayBuffer | Uint8Array): Promise<boolean> {
    try {
        const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
        const form = doc.getForm();
        return form.getFields().length > 0;
    } catch {
        return false;
    }
}

function prettifyName(name: string): string {
    // Most form field names are CamelCase or snake_case ID-ish — make them
    // nicer for the UI without inventing labels.
    return name
        .replace(/[._]+/g, ' ')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/\s+/g, ' ')
        .trim();
}

export async function extractPdfFormFields(bytes: ArrayBuffer | Uint8Array): Promise<PdfFormField[]> {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const form = doc.getForm();
    const fields = form.getFields();
    return fields.map((f): PdfFormField => {
        const name = f.getName();
        const label = prettifyName(name);
        if (f instanceof PDFTextField) {
            return { name, kind: 'text', value: f.getText() ?? '', label };
        }
        if (f instanceof PDFCheckBox) {
            return { name, kind: 'checkbox', value: f.isChecked(), label };
        }
        if (f instanceof PDFRadioGroup) {
            return {
                name,
                kind: 'radio',
                value: f.getSelected() ?? '',
                options: f.getOptions(),
                label
            };
        }
        if (f instanceof PDFDropdown) {
            const sel = f.getSelected();
            return {
                name,
                kind: 'dropdown',
                value: Array.isArray(sel) ? (sel[0] ?? '') : (sel ?? ''),
                options: f.getOptions(),
                label
            };
        }
        return { name, kind: 'unknown', value: '', label };
    });
}

/** Fill the AcroForm fields and return the modified PDF bytes. Skips
 *  values for unknown fields. Does NOT flatten — recipients can still
 *  re-edit unless the caller passes flatten=true. */
export async function fillPdfForm(
    bytes: ArrayBuffer | Uint8Array,
    values: Record<string, string | boolean>,
    opts: { flatten?: boolean } = {}
): Promise<Uint8Array> {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const form = doc.getForm();
    for (const [name, value] of Object.entries(values)) {
        let field;
        try { field = form.getField(name); } catch { continue; }
        if (field instanceof PDFTextField) {
            field.setText(typeof value === 'boolean' ? '' : String(value));
        } else if (field instanceof PDFCheckBox) {
            if (value) field.check(); else field.uncheck();
        } else if (field instanceof PDFRadioGroup && typeof value === 'string' && value) {
            try { field.select(value); } catch { /* invalid option */ }
        } else if (field instanceof PDFDropdown && typeof value === 'string' && value) {
            try { field.select(value); } catch { /* invalid option */ }
        }
    }
    if (opts.flatten) form.flatten();
    return doc.save();
}
