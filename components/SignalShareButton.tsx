'use client';

import { useState } from 'react';
import type { SignalPayload } from '@/lib/digest';
import { buildSignalCard, formatSignalForShare } from '@/lib/signalCard';

interface SignalShareButtonProps {
  signal: SignalPayload;
}

export function SignalShareButton({ signal }: SignalShareButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleShare = async () => {
    const baseUrl = typeof window !== 'undefined' ? window.location.origin : 'https://financial.nuwrrrld.com';
    const card = buildSignalCard(signal, baseUrl, 'https://financial.nuwrrrld.com');
    const text = formatSignalForShare(signal);
    const fullText = `${text}\n\n${card.shareUrl}`;

    // Try native Web Share API first (mobile-friendly)
    if (navigator.share) {
      try {
        await navigator.share({
          title: `Signal: ${signal.ticker}`,
          text: fullText,
          url: card.shareUrl,
        });
        return;
      } catch (e) {
        // User cancelled or share failed, fall back to copy
        console.error('Share failed:', e);
      }
    }

    // Fallback: copy to clipboard
    try {
      await navigator.clipboard.writeText(fullText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error('Copy failed:', e);
      alert('Failed to copy share link');
    }
  };

  return (
    <button
      onClick={handleShare}
      className="signal-share-btn"
      title={copied ? 'Copied!' : 'Share this signal'}
    >
      {copied ? '✓ Copied' : '📤 Share'}
    </button>
  );
}
