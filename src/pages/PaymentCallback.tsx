/**
 * /payments/callback?reference=… — return from the provider's hosted checkout
 * (Phase 18). Server-side verification runs here; the outcome is displayed
 * honestly. Card/mobile-money details were entered ONLY on the provider page.
 */
import React, { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CheckCircle2, XCircle, RefreshCw } from 'lucide-react';
import { api } from '../services/api';

export default function PaymentCallback() {
  const [params] = useSearchParams();
  const reference = params.get('reference') || '';
  const [state, setState] = useState<'verifying' | 'complete' | 'failed'>('verifying');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!reference) { setState('failed'); setMessage('No payment reference was supplied.'); return; }
    api.payments.verify(reference)
      .then((d: any) => {
        const status = d?.purchase?.status;
        if (status === 'complete') { setState('complete'); }
        else if (status === 'refunded') { setState('failed'); setMessage('This purchase was refunded.'); }
        else { setState('failed'); setMessage(d?.error || 'The payment has not completed.'); }
      })
      .catch((e: any) => { setState('failed'); setMessage(e?.message || 'Verification failed.'); });
  }, [reference]);

  return (
    <div className="section-container max-w-md py-16 md:py-24 text-center">
      <div className="card p-8">
        {state === 'verifying' && (
          <>
            <div className="w-12 h-12 rounded-xl bg-rx-yellow/10 flex items-center justify-center mx-auto">
              <div className="w-5 h-5 rounded-full border-2 border-rx-dark/30 border-t-rx-dark animate-spin" style={{ borderColor: 'rgba(255,214,0,.3)', borderTopColor: '#FFD600' }} />
            </div>
            <h1 className="text-xl font-bold text-white mt-4">Verifying your payment…</h1>
            <p className="text-sm text-rx-gray-medium mt-2">Confirming with the payment provider.</p>
          </>
        )}
        {state === 'complete' && (
          <>
            <CheckCircle2 className="w-12 h-12 text-green-400 mx-auto" />
            <h1 className="text-xl font-bold text-white mt-4">Purchase complete 🎉</h1>
            <p className="text-sm text-rx-gray-medium mt-2">You now own this application — download it on any of your devices.</p>
            <Link to="/profile?tab=purchases" className="btn-primary text-sm mt-6 inline-block">View my purchases</Link>
          </>
        )}
        {state === 'failed' && (
          <>
            <XCircle className="w-12 h-12 text-rx-yellow mx-auto" />
            <h1 className="text-xl font-bold text-white mt-4">Payment not completed</h1>
            <p className="text-sm text-rx-gray-medium mt-2">{message}</p>
            <Link to="/browse" className="btn-secondary text-sm mt-6 inline-block">Back to browsing</Link>
          </>
        )}
        <p className="text-[11px] text-rx-gray-medium/70 mt-6 flex items-center justify-center gap-1.5">
          <RefreshCw className="w-3 h-3" /> Payments are processed securely by the provider — RX Store never sees your card details.
        </p>
      </div>
    </div>
  );
}
