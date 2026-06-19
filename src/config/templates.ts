import { LeadProfile } from '../schemas/leadProfile';
import { LeadQualification } from '../engines/qualificationEngine';

export type TemplateKey =
  | 'website_buyer_hot'
  | 'facebook_buyer_warm'
  | 'ghost_reactivation'
  | 'generic_hot'
  | 'generic_warm'
  | 'generic_cold';

export interface TemplateVars {
  firstName: string;
  property?: string;
  city?: string;
}

type SmsTemplate = (vars: TemplateVars) => string;
type EmailTemplate = (vars: TemplateVars) => { subject: string; body: string };

export const SMS_TEMPLATES: Record<TemplateKey, SmsTemplate> = {
  website_buyer_hot: (vars) =>
    `Hi ${vars.firstName}, I saw you viewed ${vars.property ?? 'that property'} — want me to set up a quick showing?`,
  facebook_buyer_warm: (vars) =>
    `Hi ${vars.firstName}, thanks for your interest in ${vars.city ?? 'the area'} — happy to send over some options if you're still looking.`,
  ghost_reactivation: (vars) =>
    `Hi ${vars.firstName}, haven't heard from you in a while — still in the market, or has your plan changed?`,
  generic_hot: (vars) =>
    `Hi ${vars.firstName}, following up on your home search — want me to put together some options for you?`,
  generic_warm: (vars) =>
    `Hi ${vars.firstName}, just checking in on your home search — let me know if you'd like some options.`,
  generic_cold: (vars) =>
    `Hi ${vars.firstName}, here are a few listings that might interest you — let me know if anything stands out.`,
};

export const EMAIL_TEMPLATES: Record<TemplateKey, EmailTemplate> = {
  website_buyer_hot: (vars) => ({
    subject: `${vars.property ?? 'That property'} you viewed`,
    body: `Hi ${vars.firstName},\n\nI saw you viewed ${vars.property ?? 'a property'} recently. Want me to set up a quick showing?`,
  }),
  facebook_buyer_warm: (vars) => ({
    subject: `${vars.city ?? 'Your area'} home search`,
    body: `Hi ${vars.firstName},\n\nThanks for your interest in ${vars.city ?? 'the area'}. Happy to send over some options if you're still looking.`,
  }),
  ghost_reactivation: (vars) => ({
    subject: 'Still looking?',
    body: `Hi ${vars.firstName},\n\nHaven't heard from you in a while — still in the market, or has your plan changed?`,
  }),
  generic_hot: (vars) => ({
    subject: 'Your home search',
    body: `Hi ${vars.firstName},\n\nFollowing up on your home search — want me to put together some options for you?`,
  }),
  generic_warm: (vars) => ({
    subject: 'Checking in',
    body: `Hi ${vars.firstName},\n\nJust checking in on your home search — let me know if you'd like some options.`,
  }),
  generic_cold: (vars) => ({
    subject: 'A few listings for you',
    body: `Hi ${vars.firstName},\n\nHere are a few listings that might interest you — let me know if anything stands out.`,
  }),
};

/**
 * Picks which template to use based on source + intent for the named
 * combos, falling back to a generic template per qualification status for
 * everything else.
 */
export function selectTemplateKey(leadProfile: LeadProfile, qualification: LeadQualification): TemplateKey {
  if (qualification.status === 'ghost') return 'ghost_reactivation';

  const source = leadProfile.source.toLowerCase();
  if (source === 'website' && leadProfile.leadIntent === 'buyer' && qualification.status === 'hot') {
    return 'website_buyer_hot';
  }
  if (source === 'facebook' && leadProfile.leadIntent === 'buyer' && qualification.status === 'warm') {
    return 'facebook_buyer_warm';
  }

  switch (qualification.status) {
    case 'hot':
      return 'generic_hot';
    case 'warm':
      return 'generic_warm';
    default:
      return 'generic_cold';
  }
}
