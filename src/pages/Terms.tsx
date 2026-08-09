import React from 'react';
import LegalDoc, { LegalSection } from '../components/legal/LegalDoc';

const SECTIONS: LegalSection[] = [
  {
    heading: '1. Using Our Services',
    body: [
      'You agree to use our services lawfully and responsibly. You must not:\nAttempt to gain unauthorized access\nDistribute malicious software\nAbuse our infrastructure\nCircumvent security measures\nMisuse another user’s account\nUse our services for unlawful activities',
    ],
  },
  {
    heading: '2. Rx Store',
    body: [
      'Rx Store provides a platform for discovering, downloading, installing, and updating software and applications. Applications available through Rx Store may be developed and maintained by Calcitonin Technologies or by third-party developers.',
    ],
  },
  {
    heading: '3. Application Licenses',
    body: [
      'Downloading an application does not automatically transfer ownership of that application to you. Applications may be provided under their respective licenses and terms. You agree to comply with the applicable license for each application.',
    ],
  },
  {
    heading: '4. Accounts',
    body: [
      'You are responsible for maintaining the security of your account and credentials. You should immediately notify us if you believe your account has been compromised.',
    ],
  },
  {
    heading: '5. Payments and Subscriptions',
    body: [
      'Some applications or features may require payment or a subscription. Prices, billing periods, cancellation rules, and applicable taxes will be displayed before purchase.',
    ],
  },
  {
    heading: '6. Updates',
    body: [
      'Applications may receive updates for:\nSecurity\nBug fixes\nPerformance\nNew features\nCompatibility\nSome updates may be necessary for continued use of a service.',
    ],
  },
  {
    heading: '7. Intellectual Property',
    body: [
      'Unless otherwise stated, Calcitonin Technologies owns or licenses the intellectual property associated with its services, including software, branding, graphics, and content. You may not copy, modify, redistribute, or commercially exploit our intellectual property without appropriate authorization.',
    ],
  },
  {
    heading: '8. Third-Party Applications',
    body: [
      'Third-party applications available through Rx Store may have their own developers, licenses, privacy policies, and terms. Calcitonin Technologies is not responsible for content or functionality outside our control.',
    ],
  },
  {
    heading: '9. Service Availability',
    body: [
      'We aim to provide reliable services but cannot guarantee that every service will always be available, uninterrupted, or error-free.',
    ],
  },
  {
    heading: '10. Suspension or Termination',
    body: [
      'We may suspend or terminate access where necessary to:\nProtect our users\nProtect our infrastructure\nPrevent abuse\nComply with legal requirements\nAddress violations of these Terms',
    ],
  },
  {
    heading: '11. Changes to These Terms',
    body: [
      'We may update these Terms as our services develop. Continued use after an update constitutes acceptance of the revised Terms where legally applicable.',
    ],
  },
  {
    heading: '12. Contact',
    body: [
      'For questions regarding these Terms:\nCalcitonin Technologies\nEmail: `legal@yourdomain.com`',
    ],
  },
];

export default function Terms() {
  return (
    <LegalDoc
      title="Terms of Service"
      updated="August 9, 2026"
      intro="These Terms of Service govern your use of websites, applications, software, and services operated by Calcitonin Technologies, including Rx Store. By accessing or using our services, you agree to these Terms."
      sections={SECTIONS}
    />
  );
}
