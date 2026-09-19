/**
 * Visitor-surface copy, by locale (audit UX-6).
 *
 * The disclosure was already per-tenant configurable, but every other string,
 * the consent prompt, the error messages, the placeholder, the accessibility
 * hints, was inline English in the panel markup. A product positioned for the
 * EU and for multi-entity groups with jurisdiction rules could not serve a
 * French or German visitor.
 *
 * Two rules shape this file:
 *
 *  - consent wording is stored verbatim, per locale, and is what gets recorded
 *    in the consent event. The evidence is the words the visitor actually saw,
 *    so a translated prompt must produce a translated record, not an English
 *    one with a language tag attached;
 *  - the disclosure line here is a fallback only. A tenant's own disclosure,
 *    in their own voice, overrides it, and cannot be removed in any locale.
 */
export interface LocaleBundle {
  readonly locale: string;
  readonly dir: 'ltr' | 'rtl';
  readonly strings: Readonly<Record<LocaleKey, string>>;
}

export type LocaleKey =
  | 'title'
  | 'disclosure'
  | 'placeholder'
  | 'send'
  | 'sending'
  | 'close'
  | 'closeHint'
  | 'openHint'
  | 'conversationLabel'
  | 'messageLabel'
  | 'consentWording'
  | 'consentExplain'
  | 'consentExplainBody'
  | 'privacyLink'
  | 'yes'
  | 'no'
  | 'consentAccepted'
  | 'consentRefused'
  | 'forgetMe'
  | 'forgotten'
  | 'thinking'
  | 'errorGeneric'
  | 'errorUnavailable'
  | 'retry'
  | 'bookingCta'
  | 'awaitHuman'
  | 'awaitHumanNotified'
  | 'leaveDetails'
  | 'leaveDetailsCta'
  | 'emailPlaceholder'
  | 'detailsReceived'
  | 'you'
  | 'assistant';

const EN: Readonly<Record<LocaleKey, string>> = {
  title: 'Assistant',
  disclosure: 'You are chatting with an AI assistant, not a person.',
  placeholder: 'Type your message',
  send: 'Send',
  sending: 'Sending',
  close: 'Close',
  closeHint: 'Close the assistant',
  openHint: 'Opens an AI assistant. You are not speaking with a person. A text-only route is available.',
  conversationLabel: 'Conversation',
  messageLabel: 'Your message',
  consentWording: 'May we check whether we already know you, so we can put you through to the right person?',
  consentExplain: 'What does this mean?',
  consentExplainBody:
    'If you say yes, we check the email address or company you give us against our own customer records, so we can route you to the right person. We do not track you across other websites, and we do not add you to any marketing list.',
  privacyLink: 'Privacy notice',
  yes: 'Yes',
  no: 'No',
  consentAccepted: 'Thanks, noted.',
  consentRefused: 'No problem. I will treat you as a new enquiry.',
  forgetMe: 'Forget me',
  forgotten: 'Done. This conversation has been cleared and nothing has been kept.',
  thinking: 'Assistant is typing',
  errorGeneric: 'Something went wrong at our end. Someone from the team can pick this up.',
  errorUnavailable: 'The assistant is unavailable right now.',
  retry: 'Try again',
  bookingCta: 'Book a time with the team',
  awaitHuman: 'I have passed this to the team.',
  awaitHumanNotified: 'The team has been notified.',
  leaveDetails: 'Nobody is available right now. Leave an email address and the team will come back to you.',
  leaveDetailsCta: 'Send',
  emailPlaceholder: 'you@company.com',
  detailsReceived: 'Thank you; the team has your details.',
  you: 'You',
  assistant: 'Assistant',
};

const FR: Readonly<Record<LocaleKey, string>> = {
  title: 'Assistant',
  disclosure: "Vous discutez avec un assistant IA, et non avec une personne.",
  placeholder: 'Écrivez votre message',
  send: 'Envoyer',
  sending: 'Envoi',
  close: 'Fermer',
  closeHint: "Fermer l'assistant",
  openHint: "Ouvre un assistant IA. Vous ne parlez pas à une personne. Une option uniquement textuelle est disponible.",
  conversationLabel: 'Conversation',
  messageLabel: 'Votre message',
  consentWording: 'Pouvons-nous vérifier si nous vous connaissons déjà, afin de vous orienter vers la bonne personne ?',
  consentExplain: "Qu'est-ce que cela signifie ?",
  consentExplainBody:
    "Si vous acceptez, nous comparons l'adresse e-mail ou le nom de société que vous nous donnez avec nos propres fichiers clients, afin de vous orienter vers la bonne personne. Nous ne vous suivons pas sur d'autres sites et ne vous inscrivons à aucune liste marketing.",
  privacyLink: 'Politique de confidentialité',
  yes: 'Oui',
  no: 'Non',
  consentAccepted: 'Merci, c’est noté.',
  consentRefused: 'Pas de problème. Je vous traite comme une nouvelle demande.',
  forgetMe: 'Effacer mes données',
  forgotten: "C'est fait. Cette conversation a été effacée et rien n'a été conservé.",
  thinking: "L'assistant écrit",
  errorGeneric: "Un incident est survenu de notre côté. Un membre de l'équipe peut prendre le relais.",
  errorUnavailable: "L'assistant est indisponible pour le moment.",
  retry: 'Réessayer',
  bookingCta: "Réserver un créneau avec l'équipe",
  awaitHuman: "J'ai transmis votre demande à l'équipe.",
  awaitHumanNotified: "L'équipe a été prévenue.",
  leaveDetails: "Personne n'est disponible actuellement. Laissez une adresse e-mail et l'équipe vous recontactera.",
  leaveDetailsCta: 'Envoyer',
  emailPlaceholder: 'vous@entreprise.com',
  detailsReceived: "Merci, l'équipe a vos coordonnées.",
  you: 'Vous',
  assistant: 'Assistant',
};

const DE: Readonly<Record<LocaleKey, string>> = {
  title: 'Assistent',
  disclosure: 'Sie chatten mit einem KI-Assistenten, nicht mit einer Person.',
  placeholder: 'Nachricht eingeben',
  send: 'Senden',
  sending: 'Wird gesendet',
  close: 'Schließen',
  closeHint: 'Assistenten schließen',
  openHint: 'Öffnet einen KI-Assistenten. Sie sprechen nicht mit einer Person. Eine reine Textoption ist verfügbar.',
  conversationLabel: 'Unterhaltung',
  messageLabel: 'Ihre Nachricht',
  consentWording: 'Dürfen wir prüfen, ob wir Sie bereits kennen, um Sie an die richtige Person weiterzuleiten?',
  consentExplain: 'Was bedeutet das?',
  consentExplainBody:
    'Wenn Sie zustimmen, gleichen wir die von Ihnen angegebene E-Mail-Adresse oder Firma mit unseren eigenen Kundendaten ab, um Sie an die richtige Person weiterzuleiten. Wir verfolgen Sie nicht über andere Websites und nehmen Sie in keinen Marketingverteiler auf.',
  privacyLink: 'Datenschutzhinweis',
  yes: 'Ja',
  no: 'Nein',
  consentAccepted: 'Danke, vermerkt.',
  consentRefused: 'Kein Problem. Ich behandle Sie als neue Anfrage.',
  forgetMe: 'Meine Daten löschen',
  forgotten: 'Erledigt. Diese Unterhaltung wurde gelöscht und nichts wurde gespeichert.',
  thinking: 'Der Assistent schreibt',
  errorGeneric: 'Bei uns ist etwas schiefgelaufen. Jemand aus dem Team kann das übernehmen.',
  errorUnavailable: 'Der Assistent ist derzeit nicht verfügbar.',
  retry: 'Erneut versuchen',
  bookingCta: 'Termin mit dem Team buchen',
  awaitHuman: 'Ich habe das an das Team weitergegeben.',
  awaitHumanNotified: 'Das Team wurde benachrichtigt.',
  leaveDetails: 'Derzeit ist niemand verfügbar. Hinterlassen Sie eine E-Mail-Adresse, das Team meldet sich.',
  leaveDetailsCta: 'Senden',
  emailPlaceholder: 'sie@firma.de',
  detailsReceived: 'Danke, das Team hat Ihre Kontaktdaten.',
  you: 'Sie',
  assistant: 'Assistent',
};

const ES: Readonly<Record<LocaleKey, string>> = {
  title: 'Asistente',
  disclosure: 'Está hablando con un asistente de IA, no con una persona.',
  placeholder: 'Escriba su mensaje',
  send: 'Enviar',
  sending: 'Enviando',
  close: 'Cerrar',
  closeHint: 'Cerrar el asistente',
  openHint: 'Abre un asistente de IA. No está hablando con una persona. Hay una opción solo de texto.',
  conversationLabel: 'Conversación',
  messageLabel: 'Su mensaje',
  consentWording: '¿Podemos comprobar si ya le conocemos, para dirigirle a la persona adecuada?',
  consentExplain: '¿Qué significa esto?',
  consentExplainBody:
    'Si acepta, comparamos el correo electrónico o la empresa que nos indique con nuestros propios registros de clientes, para dirigirle a la persona adecuada. No le seguimos por otros sitios web ni le añadimos a ninguna lista de marketing.',
  privacyLink: 'Aviso de privacidad',
  yes: 'Sí',
  no: 'No',
  consentAccepted: 'Gracias, anotado.',
  consentRefused: 'Sin problema. Le trataré como una consulta nueva.',
  forgetMe: 'Olvidar mis datos',
  forgotten: 'Hecho. Esta conversación se ha borrado y no se ha guardado nada.',
  thinking: 'El asistente está escribiendo',
  errorGeneric: 'Algo ha fallado por nuestra parte. Alguien del equipo puede ocuparse.',
  errorUnavailable: 'El asistente no está disponible en este momento.',
  retry: 'Reintentar',
  bookingCta: 'Reservar una cita con el equipo',
  awaitHuman: 'He pasado esto al equipo.',
  awaitHumanNotified: 'Se ha avisado al equipo.',
  leaveDetails: 'Ahora mismo no hay nadie disponible. Deje un correo electrónico y el equipo le responderá.',
  leaveDetailsCta: 'Enviar',
  emailPlaceholder: 'usted@empresa.com',
  detailsReceived: 'Gracias, el equipo tiene sus datos.',
  you: 'Usted',
  assistant: 'Asistente',
};

const NL: Readonly<Record<LocaleKey, string>> = {
  title: 'Assistent',
  disclosure: 'U chat met een AI-assistent, niet met een persoon.',
  placeholder: 'Typ uw bericht',
  send: 'Versturen',
  sending: 'Versturen',
  close: 'Sluiten',
  closeHint: 'Assistent sluiten',
  openHint: 'Opent een AI-assistent. U spreekt niet met een persoon. Er is een optie met alleen tekst.',
  conversationLabel: 'Gesprek',
  messageLabel: 'Uw bericht',
  consentWording: 'Mogen we controleren of we u al kennen, zodat we u naar de juiste persoon kunnen doorverwijzen?',
  consentExplain: 'Wat betekent dit?',
  consentExplainBody:
    'Als u ja zegt, vergelijken we het e-mailadres of bedrijf dat u opgeeft met onze eigen klantgegevens, zodat we u naar de juiste persoon kunnen doorverwijzen. We volgen u niet op andere websites en zetten u op geen enkele marketinglijst.',
  privacyLink: 'Privacyverklaring',
  yes: 'Ja',
  no: 'Nee',
  consentAccepted: 'Dank u, genoteerd.',
  consentRefused: 'Geen probleem. Ik behandel u als een nieuwe aanvraag.',
  forgetMe: 'Vergeet mij',
  forgotten: 'Gedaan. Dit gesprek is gewist en er is niets bewaard.',
  thinking: 'De assistent typt',
  errorGeneric: 'Er is iets misgegaan aan onze kant. Iemand van het team kan dit oppakken.',
  errorUnavailable: 'De assistent is op dit moment niet beschikbaar.',
  retry: 'Opnieuw proberen',
  bookingCta: 'Een tijd met het team inplannen',
  awaitHuman: 'Ik heb dit doorgegeven aan het team.',
  awaitHumanNotified: 'Het team is op de hoogte gebracht.',
  leaveDetails: 'Er is nu niemand beschikbaar. Laat een e-mailadres achter en het team neemt contact op.',
  leaveDetailsCta: 'Versturen',
  emailPlaceholder: 'u@bedrijf.nl',
  detailsReceived: 'Dank u, het team heeft uw gegevens.',
  you: 'U',
  assistant: 'Assistent',
};

const IT: Readonly<Record<LocaleKey, string>> = {
  title: 'Assistente',
  disclosure: 'Stai parlando con un assistente IA, non con una persona.',
  placeholder: 'Scrivi il tuo messaggio',
  send: 'Invia',
  sending: 'Invio',
  close: 'Chiudi',
  closeHint: "Chiudi l'assistente",
  openHint: "Apre un assistente IA. Non stai parlando con una persona. È disponibile un'opzione solo testo.",
  conversationLabel: 'Conversazione',
  messageLabel: 'Il tuo messaggio',
  consentWording: 'Possiamo verificare se già ti conosciamo, per indirizzarti alla persona giusta?',
  consentExplain: 'Che cosa significa?',
  consentExplainBody:
    "Se accetti, confrontiamo l'indirizzo e-mail o l'azienda che ci indichi con i nostri archivi clienti, per indirizzarti alla persona giusta. Non ti seguiamo su altri siti e non ti inseriamo in alcuna lista di marketing.",
  privacyLink: 'Informativa sulla privacy',
  yes: 'Sì',
  no: 'No',
  consentAccepted: 'Grazie, annotato.',
  consentRefused: 'Nessun problema. Ti tratterò come una nuova richiesta.',
  forgetMe: 'Dimenticami',
  forgotten: 'Fatto. Questa conversazione è stata cancellata e non è stato conservato nulla.',
  thinking: "L'assistente sta scrivendo",
  errorGeneric: 'Qualcosa è andato storto da parte nostra. Qualcuno del team può occuparsene.',
  errorUnavailable: "L'assistente non è disponibile in questo momento.",
  retry: 'Riprova',
  bookingCta: 'Prenota un incontro con il team',
  awaitHuman: "Ho passato la richiesta al team.",
  awaitHumanNotified: 'Il team è stato avvisato.',
  leaveDetails: "Al momento non c'è nessuno disponibile. Lascia un indirizzo e-mail e il team ti ricontatterà.",
  leaveDetailsCta: 'Invia',
  emailPlaceholder: 'tu@azienda.it',
  detailsReceived: 'Grazie, il team ha i tuoi contatti.',
  you: 'Tu',
  assistant: 'Assistente',
};

const BUNDLES: Readonly<Record<string, Readonly<Record<LocaleKey, string>>>> = {
  'en-gb': EN, fr: FR, de: DE, es: ES, nl: NL, it: IT,
};

export const SUPPORTED_LOCALES = ['en-GB', 'fr', 'de', 'es', 'nl', 'it'] as const;

/**
 * Pick the closest supported locale.
 *
 * Language-only match, then the default. Deliberately not an Accept-Language
 * quality-value negotiation: the panel is told which locale to use by the host
 * page's `lang` attribute or by tenant configuration, and inventing a preference
 * the tenant has not approved copy for would serve a visitor untranslated
 * consent wording, which is a consent record that does not match what was seen.
 */
export function negotiateLocale(requested: string, supported: readonly string[] = SUPPORTED_LOCALES): string {
  const wanted = requested.trim().toLowerCase();
  const allowed = supported.map((locale) => locale.toLowerCase());

  if (allowed.includes(wanted) && BUNDLES[wanted]) return canonical(wanted);
  const language = wanted.split('-')[0]!;
  if (allowed.includes(language) && BUNDLES[language]) return canonical(language);
  const prefixed = allowed.find((locale) => locale.split('-')[0] === language && BUNDLES[locale]);
  if (prefixed) return canonical(prefixed);
  return supported[0] ?? 'en-GB';
}

function canonical(locale: string): string {
  return locale === 'en-gb' ? 'en-GB' : locale;
}

export function localeBundle(locale: string): LocaleBundle {
  const key = locale.toLowerCase();
  return {
    locale: canonical(key),
    dir: 'ltr',
    strings: BUNDLES[key] ?? EN,
  };
}
