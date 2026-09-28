// Localized strings for the Graphics settings section. The rest of the game is
// English-only; this panel follows the browser language (navigator.language)
// with a fallback chain: exact tag → language family → en-US.

const EN = {
  title: 'Graphics',
  quality: 'Quality',
  auto: 'Auto (detected: {tier})',
  renderScale: 'Render scale',
  fromPreset: 'From preset ({tier})',
  adaptive: 'Adaptive resolution',
  adaptiveHint: 'Lowers the resolution while frames are slow, raises it again when they are fast.',
  showFps: 'Show frame rate',
  postFailed: 'Post-processing is unavailable on this device, so the garden is drawn without it.',
  note: 'Graphics settings change visuals only — never the rules or hazard visibility.',
  camera: 'Camera',
  cameraDefault: 'Angled (default)',
  cameraTop: 'Top-down',
  cat: {
    shadows: 'Shadows', ao: 'Ambient occlusion', bloom: 'Bloom (glow)', grade: 'Colour grade & vignette',
    antialias: 'Anti-aliasing', reflections: 'Reflections', foliage: 'Grass & flowers',
    particles: 'Particles & pollen', detail: 'Surface detail',
  },
  tier: {
    off: 'Off', on: 'On', low: 'Low', medium: 'Medium', high: 'High', balanced: 'Balanced', ultra: 'Ultra',
    fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', sparse: 'Sparse', dense: 'Dense', plain: 'Plain', detailed: 'Detailed',
  },
  sum: {
    noShadows: 'no shadows', shadows: 'shadows', ao: 'ambient occlusion', aoHigh: 'full ambient occlusion',
    bloom: 'bloom', reflections: 'reflections', grass: 'grass blades', noAa: 'no anti-aliasing', gpu: 'unknown GPU',
  },
};

const US = { ...EN, cat: { ...EN.cat, grade: 'Color grade & vignette' } };

const ES = {
  title: 'Gráficos',
  quality: 'Calidad',
  auto: 'Automática (detectada: {tier})',
  renderScale: 'Escala de renderizado',
  fromPreset: 'Según el ajuste ({tier})',
  adaptive: 'Resolución adaptativa',
  adaptiveHint: 'Baja la resolución cuando los fotogramas van lentos y la vuelve a subir cuando van rápidos.',
  showFps: 'Mostrar fotogramas por segundo',
  postFailed: 'El posprocesado no está disponible en este dispositivo, así que el jardín se dibuja sin él.',
  note: 'Los ajustes gráficos solo cambian el aspecto: nunca las reglas ni la visibilidad de los peligros.',
  camera: 'Cámara',
  cameraDefault: 'Inclinada (predeterminada)',
  cameraTop: 'Cenital',
  cat: {
    shadows: 'Sombras', ao: 'Oclusión ambiental', bloom: 'Resplandor', grade: 'Corrección de color y viñeta',
    antialias: 'Suavizado de bordes', reflections: 'Reflejos', foliage: 'Hierba y flores',
    particles: 'Partículas y polen', detail: 'Detalle de superficies',
  },
  tier: {
    off: 'No', on: 'Sí', low: 'Baja', medium: 'Media', high: 'Alta', balanced: 'Equilibrada', ultra: 'Ultra',
    fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', sparse: 'Escasa', dense: 'Densa', plain: 'Simple', detailed: 'Detallado',
  },
  sum: {
    noShadows: 'sin sombras', shadows: 'sombras', ao: 'oclusión ambiental', aoHigh: 'oclusión ambiental completa',
    bloom: 'resplandor', reflections: 'reflejos', grass: 'briznas de hierba', noAa: 'sin suavizado', gpu: 'GPU desconocida',
  },
};

const ES_ES = {
  ...ES,
  renderScale: 'Escala de renderizado',
  showFps: 'Mostrar FPS',
  fromPreset: 'Según el preajuste ({tier})',
};

const DE = {
  title: 'Grafik',
  quality: 'Qualität',
  auto: 'Automatisch (erkannt: {tier})',
  renderScale: 'Renderskalierung',
  fromPreset: 'Aus Voreinstellung ({tier})',
  adaptive: 'Adaptive Auflösung',
  adaptiveHint: 'Senkt die Auflösung, wenn Bilder langsam sind, und hebt sie wieder an, wenn sie schnell sind.',
  showFps: 'Bildrate anzeigen',
  postFailed: 'Nachbearbeitung ist auf diesem Gerät nicht verfügbar, daher wird der Garten ohne sie gezeichnet.',
  note: 'Grafikeinstellungen ändern nur die Darstellung – nie die Regeln oder die Sichtbarkeit von Gefahren.',
  camera: 'Kamera',
  cameraDefault: 'Schräg (Standard)',
  cameraTop: 'Von oben',
  cat: {
    shadows: 'Schatten', ao: 'Umgebungsverdeckung', bloom: 'Leuchten (Bloom)', grade: 'Farbkorrektur & Vignette',
    antialias: 'Kantenglättung', reflections: 'Reflexionen', foliage: 'Gras & Blumen',
    particles: 'Partikel & Pollen', detail: 'Oberflächendetails',
  },
  tier: {
    off: 'Aus', on: 'An', low: 'Niedrig', medium: 'Mittel', high: 'Hoch', balanced: 'Ausgewogen', ultra: 'Ultra',
    fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', sparse: 'Spärlich', dense: 'Dicht', plain: 'Einfach', detailed: 'Detailliert',
  },
  sum: {
    noShadows: 'keine Schatten', shadows: 'Schatten', ao: 'Umgebungsverdeckung', aoHigh: 'volle Umgebungsverdeckung',
    bloom: 'Leuchten', reflections: 'Reflexionen', grass: 'Grashalme', noAa: 'keine Kantenglättung', gpu: 'unbekannte GPU',
  },
};

const FR = {
  title: 'Graphismes',
  quality: 'Qualité',
  auto: 'Automatique (détectée : {tier})',
  renderScale: 'Échelle de rendu',
  fromPreset: 'Selon le préréglage ({tier})',
  adaptive: 'Résolution adaptative',
  adaptiveHint: 'Baisse la résolution quand les images sont lentes, puis la remonte quand elles sont rapides.',
  showFps: 'Afficher la fréquence d’images',
  postFailed: 'Le post-traitement n’est pas disponible sur cet appareil ; le jardin est donc dessiné sans lui.',
  note: 'Les réglages graphiques ne changent que l’apparence — jamais les règles ni la visibilité des dangers.',
  camera: 'Caméra',
  cameraDefault: 'Inclinée (par défaut)',
  cameraTop: 'Vue de dessus',
  cat: {
    shadows: 'Ombres', ao: 'Occlusion ambiante', bloom: 'Halo lumineux', grade: 'Étalonnage et vignette',
    antialias: 'Anticrénelage', reflections: 'Reflets', foliage: 'Herbe et fleurs',
    particles: 'Particules et pollen', detail: 'Détail des surfaces',
  },
  tier: {
    off: 'Non', on: 'Oui', low: 'Faible', medium: 'Moyenne', high: 'Élevée', balanced: 'Équilibrée', ultra: 'Ultra',
    fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', sparse: 'Clairsemée', dense: 'Dense', plain: 'Simple', detailed: 'Détaillé',
  },
  sum: {
    noShadows: 'sans ombres', shadows: 'ombres', ao: 'occlusion ambiante', aoHigh: 'occlusion ambiante complète',
    bloom: 'halo', reflections: 'reflets', grass: 'brins d’herbe', noAa: 'sans anticrénelage', gpu: 'GPU inconnu',
  },
};

const FR_CA = {
  ...FR,
  showFps: 'Afficher le nombre d’images par seconde',
  cat: { ...FR.cat, antialias: 'Lissage des contours' },
  sum: { ...FR.sum, noAa: 'sans lissage', gpu: 'processeur graphique inconnu' },
};

const PT_BR = {
  title: 'Gráficos',
  quality: 'Qualidade',
  auto: 'Automática (detectada: {tier})',
  renderScale: 'Escala de renderização',
  fromPreset: 'Da predefinição ({tier})',
  adaptive: 'Resolução adaptativa',
  adaptiveHint: 'Reduz a resolução quando os quadros ficam lentos e aumenta de novo quando ficam rápidos.',
  showFps: 'Mostrar taxa de quadros',
  postFailed: 'O pós-processamento não está disponível neste dispositivo, então o jardim é desenhado sem ele.',
  note: 'As configurações gráficas mudam só o visual — nunca as regras nem a visibilidade dos perigos.',
  camera: 'Câmera',
  cameraDefault: 'Inclinada (padrão)',
  cameraTop: 'De cima',
  cat: {
    shadows: 'Sombras', ao: 'Oclusão ambiente', bloom: 'Brilho (bloom)', grade: 'Correção de cor e vinheta',
    antialias: 'Suavização de bordas', reflections: 'Reflexos', foliage: 'Grama e flores',
    particles: 'Partículas e pólen', detail: 'Detalhe das superfícies',
  },
  tier: {
    off: 'Desligado', on: 'Ligado', low: 'Baixa', medium: 'Média', high: 'Alta', balanced: 'Equilibrada', ultra: 'Ultra',
    fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', sparse: 'Esparsa', dense: 'Densa', plain: 'Simples', detailed: 'Detalhado',
  },
  sum: {
    noShadows: 'sem sombras', shadows: 'sombras', ao: 'oclusão ambiente', aoHigh: 'oclusão ambiente completa',
    bloom: 'brilho', reflections: 'reflexos', grass: 'folhas de grama', noAa: 'sem suavização', gpu: 'GPU desconhecida',
  },
};

const IT = {
  title: 'Grafica',
  quality: 'Qualità',
  auto: 'Automatica (rilevata: {tier})',
  renderScale: 'Scala di rendering',
  fromPreset: 'Dal preset ({tier})',
  adaptive: 'Risoluzione adattiva',
  adaptiveHint: 'Abbassa la risoluzione quando i fotogrammi sono lenti e la rialza quando sono veloci.',
  showFps: 'Mostra la frequenza dei fotogrammi',
  postFailed: 'La post-elaborazione non è disponibile su questo dispositivo, quindi il giardino viene disegnato senza.',
  note: 'Le impostazioni grafiche cambiano solo l’aspetto, mai le regole o la visibilità dei pericoli.',
  camera: 'Telecamera',
  cameraDefault: 'Inclinata (predefinita)',
  cameraTop: 'Dall’alto',
  cat: {
    shadows: 'Ombre', ao: 'Occlusione ambientale', bloom: 'Bagliore (bloom)', grade: 'Correzione colore e vignettatura',
    antialias: 'Anti-aliasing', reflections: 'Riflessi', foliage: 'Erba e fiori',
    particles: 'Particelle e polline', detail: 'Dettaglio delle superfici',
  },
  tier: {
    off: 'No', on: 'Sì', low: 'Bassa', medium: 'Media', high: 'Alta', balanced: 'Bilanciata', ultra: 'Ultra',
    fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', sparse: 'Rada', dense: 'Fitta', plain: 'Semplice', detailed: 'Dettagliato',
  },
  sum: {
    noShadows: 'senza ombre', shadows: 'ombre', ao: 'occlusione ambientale', aoHigh: 'occlusione ambientale completa',
    bloom: 'bagliore', reflections: 'riflessi', grass: 'fili d’erba', noAa: 'senza anti-aliasing', gpu: 'GPU sconosciuta',
  },
};

export const GFX_STRINGS = {
  'en-US': US, 'en-GB': EN, 'es-419': ES, 'es-ES': ES_ES, 'de-DE': DE,
  'fr-FR': FR, 'fr-CA': FR_CA, 'pt-BR': PT_BR, 'it-IT': IT,
};

const FAMILY = { en: 'en-US', es: 'es-419', de: 'de-DE', fr: 'fr-FR', pt: 'pt-BR', it: 'it-IT' };

/** Pick the best supported locale tag for a BCP-47 language tag. */
export function pickLocale(tag) {
  const t = String(tag || '').replace('_', '-');
  const exact = Object.keys(GFX_STRINGS).find((k) => k.toLowerCase() === t.toLowerCase());
  if (exact) return exact;
  const lang = t.split('-')[0].toLowerCase();
  if (lang === 'en' && /-(gb|ie|au|nz|za|in)$/i.test(t)) return 'en-GB';
  if (lang === 'es' && /-es$/i.test(t)) return 'es-ES';
  if (lang === 'fr' && /-ca$/i.test(t)) return 'fr-CA';
  return FAMILY[lang] || 'en-US';
}

export function gfxStrings(tag) {
  return GFX_STRINGS[pickLocale(tag)];
}

/** Replace {name} placeholders. */
export function fmt(s, vars) {
  return String(s).replace(/\{(\w+)\}/g, (_, k) => (vars && vars[k] != null ? vars[k] : ''));
}
