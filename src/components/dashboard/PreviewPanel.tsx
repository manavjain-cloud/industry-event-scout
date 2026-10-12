"use client";

import { Eye, Mail, Send } from "lucide-react";
import { Button, Chip, EmptyState } from "./ui";

export interface PreviewData {
  subject: string;
  html: string;
  text: string;
  readMinutes: number;
  itemCount: number;
  urgentCount: number;
  rankingAvailable: boolean;
}

export function PreviewPanel({
  preview,
  onPreview,
  onTest,
  previewing,
  testing,
  recipient,
  message,
}: {
  preview: PreviewData | null;
  onPreview: () => void;
  onTest: () => void;
  previewing: boolean;
  testing: boolean;
  recipient: string | null;
  message: { ok: boolean; text: string } | null;
}) {
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Button variant="primary" icon={Eye} onClick={onPreview} busy={previewing}>
          {preview ? "Refresh preview" : "Preview next digest"}
        </Button>
        <Button icon={Send} onClick={onTest} busy={testing} disabled={!recipient}>
          Send test email
        </Button>
        <span className="text-xs text-muted">
          {recipient ? (
            <>
              Test sends go to <span className="font-medium text-ink">{recipient}</span>, are subject-prefixed <code className="font-mono">[TEST]</code> and never count as the weekly digest.
            </>
          ) : (
            "Set a recipient email in Settings to enable test sends."
          )}
        </span>
      </div>
      <div aria-live="polite" className="mb-4 text-sm">
        {message && <p className={message.ok ? "text-lime" : "text-rose"}>{message.text}</p>}
      </div>

      {!preview ? (
        <EmptyState icon={Mail} title="Preview the Monday email">
          Renders the digest from the events already stored. Nothing is sent and no external API is called.
        </EmptyState>
      ) : (
        <div>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">{preview.subject}</span>
            <Chip>{preview.itemCount} events</Chip>
            {preview.urgentCount > 0 && <Chip tone="rose">{preview.urgentCount} closing soon</Chip>}
            <Chip>~{preview.readMinutes} min read</Chip>
            {!preview.rankingAvailable && <Chip tone="amber">Unranked (no AI scores)</Chip>}
          </div>
          <iframe
            title="Digest email preview"
            sandbox=""
            srcDoc={preview.html}
            className="h-[720px] w-full rounded-xl border border-line bg-white"
          />
          <details className="mt-3 rounded-xl border border-line bg-surface p-4">
            <summary className="cursor-pointer text-sm font-medium">Plain-text version</summary>
            <pre className="mt-3 overflow-x-auto whitespace-pre-wrap font-mono text-xs leading-relaxed text-muted">{preview.text}</pre>
          </details>
        </div>
      )}
    </div>
  );
}
