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
    `${vars.firstName}, ${vars.property ?? 'that one you viewed'} is priced right for what's moving right now. Want me to set up a walkthrough?`,
  facebook_buyer_warm: (vars) =>
    `${vars.firstName}, ${vars.city ?? 'your search area'} has had some quiet movement lately worth a look. Want me to send what's new?`,
  ghost_reactivation: (vars) =>
    `${vars.firstName}, a few solid options just hit the market in ${vars.city ?? 'your area'}. Want me to send them over?`,
  generic_hot: (vars) =>
    `${vars.firstName}, inventory's moving fast right now and a few places fit exactly what you're after. Want first look?`,
  generic_warm: (vars) =>
    `${vars.firstName}, things have shifted a bit in the market lately, worth a quick look at what's new. Want me to send a few?`,
  generic_cold: (vars) =>
    `${vars.firstName}, a couple of fresh listings line up with what you'd looked at before. Want a peek?`,
};

export const EMAIL_TEMPLATES: Record<TemplateKey, EmailTemplate> = {
  website_buyer_hot: (vars) => ({
    subject: `${vars.property ?? 'That listing'} you viewed`,
    body: `${vars.firstName}, ${vars.property ?? 'that place you viewed'} is priced right for what's moving right now. Homes like it aren't sitting long. Want me to set up a walkthrough?`,
  }),
  facebook_buyer_warm: (vars) => ({
    subject: `${vars.city ?? 'Your search area'} update`,
    body: `${vars.firstName}, ${vars.city ?? 'your search area'} has had some quiet movement lately worth a look. Want me to send what's new?`,
  }),
  ghost_reactivation: (vars) => ({
    subject: `New in ${vars.city ?? 'your area'}`,
    body: `${vars.firstName}, a few solid options just hit the market in ${vars.city ?? 'your area'}. Want me to send them over?`,
  }),
  generic_hot: (vars) => ({
    subject: 'Worth a look right now',
    body: `${vars.firstName}, inventory's moving fast right now and a few places fit exactly what you're after. Want first look?`,
  }),
  generic_warm: (vars) => ({
    subject: 'A quick market update',
    body: `${vars.firstName}, things have shifted a bit in the market lately, worth a quick look at what's new. Want me to send a few?`,
  }),
  generic_cold: (vars) => ({
    subject: 'A few fresh listings',
    body: `${vars.firstName}, a couple of fresh listings line up with what you'd looked at before. Want a peek?`,
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
