// Delivery problems with emails sent through Cloudflare Email Sending.
// An event subscription on the domain puts bounced / failed / rejected /
// complained events on a queue; this turns each one into a short alert email
// so a customer whose address bounced (a typo at checkout, a full mailbox)
// can be reached another way. Events about the business's own addresses are
// skipped, so an alert that bounces can't set off another alert.
//
// This file is shared word for word by eastern-shore-ai/worker and
// FlorenceMaeGifts.com/cloudflare. Change both together.

// Keyed by the short event name; the queue body's `type` may carry the
// `cf.email.sending.` prefix (as in Cloudflare's docs) or not.
const ALERT_TYPES = {
  'message.bounced': 'bounced',
  'message.failed': 'failed to send',
  'message.rejected': 'was rejected before sending',
  'message.complained': 'was marked as spam by the recipient'
};

// Returns { subject, text } for an alertable event, or null to ignore it.
export function describeEmailEvent(event, { internalAddresses = [] } = {}) {
  const type = String(event?.type || '').replace(/^cf\.email\.sending\./, '');
  const what = ALERT_TYPES[type];
  if (!what) return null;
  const p = event.payload || {};
  const recipient = String(p.recipient || '').trim();
  const internal = new Set(internalAddresses.map((a) => String(a || '').trim().toLowerCase()).filter(Boolean));
  if (!recipient || internal.has(recipient.toLowerCase())) return null;

  const reason = p.bounce?.reason || p.rejection?.detail || p.rejection?.reason || p.failure?.reason
    || p.delivery?.smtpResponse || (p.complaint ? `complaint: ${p.complaint.type || 'spam'}` : '') || 'no reason given';
  const when = event.metadata?.eventTimestamp ? new Date(event.metadata.eventTimestamp) : new Date();
  const whenText = when.toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' }) + ' ET';
  const complained = type === 'message.complained';

  return {
    subject: complained
      ? `Email to ${recipient} was marked as spam`
      : `[ACTION NEEDED] Email to ${recipient} ${what}`,
    text: [
      complained
        ? `${recipient} marked an email from ${p.sender || 'us'} as spam. No action is needed unless it keeps happening.`
        : `An email from ${p.sender || 'us'} did not reach ${recipient}. They have not received it.`,
      '',
      `Subject: ${p.subject || '(not given)'}`,
      `What happened: ${what}${p.bounce?.type ? ` (${p.bounce.type})` : ''}`,
      `Reason: ${reason}`,
      `When: ${whenText}`,
      `Message ID: ${p.messageId || 'n/a'}`,
      '',
      complained
        ? 'Cloudflare will stop sending to this address automatically.'
        : 'Check the address for a typo, then reach them another way (phone, or the email on their Stripe receipt). Cloudflare will not send to this address again until it is removed from the suppression list.'
    ].join('\n')
  };
}

// Queue consumer body. `notify({ subject, text })` sends the alert and returns
// a Response-like { ok }; a failed alert is retried by the queue.
export async function handleEmailEventBatch(batch, { notify, internalAddresses = [] }) {
  for (const message of batch.messages) {
    try {
      const alert = describeEmailEvent(message.body, { internalAddresses });
      if (alert) {
        const res = await notify(alert);
        if (!res?.ok) {
          console.error('Email event alert failed', res?.status || '', alert.subject);
          message.retry({ delaySeconds: 300 });
          continue;
        }
      }
      message.ack();
    } catch (err) {
      console.error('Email event handling failed', err);
      message.retry({ delaySeconds: 300 });
    }
  }
}
