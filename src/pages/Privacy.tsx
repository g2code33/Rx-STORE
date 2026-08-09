import React from 'react';
import LegalDoc, { LegalSection } from '../components/legal/LegalDoc';

const SECTIONS: LegalSection[] = [
  {
    heading: '1. Information We Collect',
    body: [
      'We may collect information you provide directly — such as your name, email address, and account credentials when you register — as well as technical information that helps us operate the service, such as device type, platform, and basic usage activity (for example downloads and installs).',
    ],
  },
  {
    heading: '2. How We Use Information',
    body: [
      'We use information to operate, maintain, and improve our services; to deliver and update applications; to communicate with you about your account, updates, and announcements; and to keep our platform secure.',
    ],
  },
  {
    heading: '3. How We Share Information',
    body: [
      'We do not sell your personal information. We may share limited information with service providers who help us run the platform, or where required by law.',
    ],
  },
  {
    heading: '4. Payment Information',
    body: [
      'If you purchase an application, subscription, or other service, payment information may be processed by our designated payment providers. We do not need to store your complete payment-card information ourselves when it is handled securely by the payment provider.',
    ],
  },
  {
    heading: '5. Data Security',
    body: [
      'We use appropriate technical and organizational measures to protect information against unauthorized access, loss, misuse, or alteration. However, no internet service can guarantee absolute security.',
    ],
  },
  {
    heading: '6. Third-Party Services',
    body: [
      'Our services may use third-party infrastructure and services for things such as:\nCloud hosting\nAuthentication\nAnalytics\nPayments\nEmail\nArtificial intelligence\nThose services may process information according to their own privacy policies.',
    ],
  },
  {
    heading: '7. Children’s Privacy',
    body: [
      'Our services are not intentionally designed to collect personal information from children in violation of applicable laws.',
    ],
  },
  {
    heading: '8. Your Rights',
    body: [
      'Depending on applicable law, you may have rights to request access to, correction of, or deletion of your personal information.',
    ],
  },
  {
    heading: '9. Changes',
    body: [
      'We may update this Privacy Policy from time to time. The latest version will be published on this page.',
    ],
  },
  {
    heading: '10. Contact',
    body: [
      'For privacy-related questions:\nCalcitonin Technologies\nEmail: `privacy@yourdomain.com`',
    ],
  },
];

export default function Privacy() {
  return (
    <LegalDoc
      title="Privacy Policy"
      updated="August 9, 2026"
      intro="This Privacy Policy explains how Calcitonin Technologies — including Rx Store — collects, uses, and protects information when you use our websites, applications, and services."
      sections={SECTIONS}
    />
  );
}
