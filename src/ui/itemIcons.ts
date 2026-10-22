// Какой значок у строки карты пациента (вопрос 49): признак, обследование, лечение, болезнь. Жалобы, находки осмотра и
// анамнез — по таблице FINDINGS: по месту и природе (кашель, боль в груди, сыпь); витальные — по величине; анализ,
// снимок и ЭКГ — значок обследования, которое их находит; обследование — по способу; лечение — по пути введения и
// виду; болезнь — по системе органов, как у «Своих больных». Рисунки — itemIconShapes.ts и iconShapes.ts. Тест
// itemIcons.test.ts сверяет таблицы с базой: у каждой строки есть значок, лишних строк нет.
import { db } from '@/content';
import type { BodySystem, Id } from '@/content/types';
import { CARD_ICONS, type IconShape, SHELF_ICONS, SYSTEM_ICONS } from './iconShapes';
import { ITEM_SHAPES, type ItemShape } from './itemIconShapes';

/** Значок строки: свой рисунок, система органов, расспрос и фонендоскоп вкладок, весь больной и монитор полок. */
export type ItemIcon = ItemShape | `sys.${BodySystem}` | 'ask' | 'steth' | 'whole' | 'bedside';

export function iconShape(icon: ItemIcon): IconShape {
  if (icon.startsWith('sys.')) return SYSTEM_ICONS[icon.slice(4) as BodySystem];
  if (icon === 'ask') return CARD_ICONS.ask;
  if (icon === 'steth') return CARD_ICONS.examine;
  if (icon === 'whole' || icon === 'bedside') return SHELF_ICONS[icon];
  return ITEM_SHAPES[icon as ItemShape];
}

/** Жалобы, находки осмотра и анамнез: значок — и строки этого значка. */
export const FINDINGS: Partial<Record<ItemIcon, readonly Id[]>> = {
  cough: [
    'sym.chronic_cough', 'sym.cough', 'sym.cough_long', 'sym.hemoptysis', 'sym.purulent_sputum', 'sign.weak_cough',
  ],
  breath: [
    'sym.dyspnea', 'sym.dyspnea_sudden', 'sym.orthopnea', 'sym.wheezing', 'sign.interrupted_inspiration', 'sign.kussmaul',
    'sign.stridor',
  ],
  steth: [
    'sign.breath_sounds_diminished', 'sign.crackles_bilateral', 'sign.crackles_diffuse', 'sign.crackles_local',
    'sign.dullness', 'sign.heart_sounds_muffled', 'sign.pericardial_rub', 'sign.wheezes',
  ],
  headache: [
    'sym.headache', 'sym.headache_pressing', 'sym.headache_severe', 'sym.headache_unilateral', 'sym.recurrent_headache',
    'sym.thunderclap', 'sign.pericranial_tenderness',
  ],
  throat: [
    'sym.choking_liquids', 'sym.sore_throat', 'sym.swallow_trouble', 'sign.blood_pharynx', 'sign.dysphagia',
    'sign.goiter', 'sign.neck_scar', 'sign.neck_stiffness', 'sign.pharyngeal_hyperemia', 'sign.tender_cervical_nodes',
    'sign.tonsillar_exudate',
  ],
  chest: [
    'sym.chest_injury_pain', 'sym.chest_pain_exertion', 'sym.chest_pain_pressing', 'sym.chest_pain_rest_long',
    'sym.chest_tightness', 'sym.pain_cough', 'sym.pain_movement', 'sym.pain_radiation', 'sym.pericardial_pain',
    'sym.pleuritic_pain', 'sym.tearing_pain', 'sign.chest_wall_tenderness', 'sign.paradoxical_breathing',
    'sign.rib_compression_pain', 'sign.rib_crepitus', 'sign.subcutaneous_emphysema',
  ],
  belly: [
    'sym.abdomen_enlarged', 'sym.abdominal_pain', 'sym.bloating', 'sym.colicky_pain', 'sym.dagger_pain',
    'sym.epigastric_pain', 'sym.groin_bulge', 'sym.hunger_pain', 'sym.llq_pain', 'sym.pain_migration', 'sym.rlq_pain',
    'sym.ruq_pain', 'sign.ascites', 'sign.ascites_tense', 'sign.board_abdomen', 'sign.collateral_veins',
    'sign.epigastric_tenderness', 'sign.hepatomegaly', 'sign.hernia_strangulated', 'sign.liver_dullness_loss',
    'sign.llq_mass', 'sign.llq_tenderness', 'sign.murphy', 'sign.percussion_tympany', 'sign.peritoneal_signs',
    'sign.rlq_tenderness', 'sign.ruq_tenderness', 'sign.splenomegaly', 'hx.hernia',
  ],
  'sys.digestive': [
    'sym.early_satiety', 'sym.heartburn', 'sym.regurgitation', 'sign.fetor_hepaticus', 'hx.cirrhosis', 'hx.gallstones',
    'hx.uc', 'hx.ulcer',
  ],
  back: [
    'sym.back_pain', 'sym.back_radiation', 'sym.flank_pain', 'sym.pain_scapula', 'sym.saddle_numbness', 'sym.sciatica',
    'sign.cva_tenderness', 'sign.paraspinal_spasm', 'sign.slr_positive', 'sign.straight_leg_raise',
  ],
  ear: ['sym.ear_pain_behind'],
  eye: [
    'sym.aura', 'sym.diplopia', 'sym.itchy_eyes', 'sym.photophobia', 'sym.vision_blurred', 'sym.vision_loss',
    'sign.exophthalmos', 'sign.ice_test_positive', 'sign.lagophthalmos', 'sign.miosis', 'sign.mydriasis',
    'sign.nystagmus', 'sign.optic_disc_blurred', 'sign.ptosis', 'sign.retinopathy_acute', 'sign.scleral_injection',
  ],
  hand: [
    'sym.hand_spasm', 'sym.tremor', 'sym.wrist_pain', 'sign.asterixis', 'sign.finger_flexion_loss', 'sign.trousseau',
    'sign.wrist_axial_pain', 'sign.wrist_deformity', 'sign.wrist_swelling',
  ],
  foot: [
    'sym.ankle_pain', 'sym.foot_pain', 'sym.hip_pain', 'sym.knee_instability', 'sym.knee_pain', 'sym.leg_cramps',
    'sym.leg_numb', 'sym.leg_pain', 'sym.leg_tingling', 'sign.ankle_deformity', 'sign.ankle_swelling',
    'sign.calf_bruise', 'sign.calf_muscle_tenderness', 'sign.deep_vein_tenderness', 'sign.fibular_head_tenderness',
    'sign.foot_pulse_absent', 'sign.foot_swelling', 'sign.hip_tenderness', 'sign.homans', 'sign.knee_effusion',
    'sign.knee_flexion_limited', 'sign.knee_swelling', 'sign.lachman_positive', 'sign.lateral_ligament_tenderness',
    'sign.leg_cold_pale', 'sign.leg_shortened_rotated', 'sign.malleolus_tenderness', 'sign.medial_ankle_swelling',
    'sign.mt5_tenderness', 'sign.navicular_tenderness', 'sign.no_active_extension', 'sign.no_weight_bearing',
    'sign.patella_gap', 'sign.patella_tenderness', 'sign.superficial_cord', 'sign.valgus_laxity',
    'sign.varicose_veins', 'hx.leg_cast', 'hx.prior_dvt',
  ],
  swelling: ['sign.calf_swelling_3cm', 'sign.leg_edema_bilateral', 'sign.leg_swollen_whole', 'sign.pitting_edema'],
  rash: [
    'sym.hives', 'sym.rash_ring', 'sym.rash_spots', 'sym.yellow_skin', 'sign.erythema_migrans', 'sign.herpes_labialis',
    'sign.hyperpigmentation', 'sign.jaundice', 'sign.pallor', 'sign.palmar_erythema', 'sign.petechial_rash',
    'sign.rash_spreading', 'sign.spider_angiomas',
  ],
  nausea: ['sym.nausea', 'sym.vomiting'],
  stool: [
    'sym.bloody_diarrhea', 'sym.constipation', 'sym.constipation_long', 'sym.diarrhea', 'sym.green_stool', 'sym.melena',
    'sym.mucus_blood_stool', 'sym.no_stool_gas', 'sym.pain_with_stool', 'sym.pale_stool', 'sym.perianal_pain',
    'sym.stool_blood', 'sym.tenesmus', 'sign.perianal_infiltrate', 'sign.rectal_bulge',
  ],
  'sys.urinary': [
    'sym.dark_urine', 'sym.dysuria', 'sym.frequency', 'sym.groin_radiation', 'sym.hematuria', 'sym.less_urine',
    'sym.polyuria', 'sym.suprapubic_pain', 'sym.urinary_retention', 'sign.bladder_distended',
    'sign.suprapubic_tenderness', 'hx.kidney_stones',
  ],
  bleeding: [
    'sym.hematemesis', 'sym.nosebleed', 'sign.nasal_bleeding_point', 'hx.bleeding_tendency', 'hx.heavy_periods',
    'hx.recent_bleed_surgery', 'hx.vomiting_before_blood',
  ],
  'sys.airways': [
    'sym.anosmia', 'sym.nasal_congestion', 'sym.nasal_itch', 'sym.nasal_long', 'sym.purulent_nasal',
    'sym.recurrent_rhinitis', 'sym.rhinorrhea', 'sym.sneezing', 'sign.pale_nasal_mucosa', 'sign.pink_mucosa',
    'sign.purulent_discharge_nose', 'sign.sinus_tenderness', 'hx.recent_cold',
  ],
  'sys.heart': [
    'sym.palpitations', 'sign.neck_veins_distended', 'hx.angina_low_threshold', 'hx.angina_progressive',
    'hx.atrial_fibrillation', 'hx.family_cad', 'hx.heart_failure', 'hx.vascular',
  ],
  'sys.lungs': ['hx.asthma', 'hx.copd'],
  'sys.nerves': [
    'sym.transient_weakness', 'sym.weakness_one_side', 'sign.hemiparesis', 'sign.nihss', 'sign.nihss_high',
    'hx.myasthenia', 'hx.stroke_history', 'hx.stroke_tia', 'hx.tia_long', 'hx.tia_mid', 'hx.tia_short',
  ],
  'sys.metabolic': [
    'sign.acetone_breath', 'hx.diabetes', 'hx.insulin', 'hx.missed_insulin', 'hx.sulfonylurea', 'hx.thyrotoxicosis',
  ],
  'sys.bones': [
    'sym.shoulder_pain', 'sign.clavicle_crepitus', 'sign.clavicle_deformity', 'sign.clavicle_skin_tenting',
    'sign.clavicle_tenderness', 'sign.shoulder_motion_pain',
  ],
  'sys.poisoning': ['sym.antifreeze_drink', 'sym.methanol_drink'],
  hammer: [
    'sign.anisoreflexia', 'sign.ankle_reflex_low', 'sign.heel_walk_weak', 'sign.leg_hypoesthesia', 'sign.leg_paresis',
    'sign.leg_sensory_loss', 'sign.legs_paresis', 'sign.romberg_unsteady', 'sign.saddle_anesthesia',
    'sign.toe_walk_weak',
  ],
  weak: [
    'sym.fatigue', 'sym.fatigue_evening', 'sym.legs_weak', 'sym.myalgia', 'sym.neck_weakness', 'sign.head_drop',
  ],
  dizzy: ['sym.dizziness'],
  faint: ['sym.found_unconscious', 'sym.loss_of_consciousness', 'sym.syncope', 'sign.gcs_coma', 'sign.gcs_low', 'sign.postictal'],
  seizure: [
    'sym.seizure', 'sym.seizure_after_injury', 'sym.seizure_ongoing', 'hx.aed_failed', 'hx.epilepsy', 'hx.first_seizure',
    'hx.missed_aed',
  ],
  mind: ['sym.amnesia', 'sym.anxiety', 'sym.confusion', 'sym.hallucinations', 'sym.strange_behavior'],
  sleep: ['sym.daytime_sleepiness', 'sym.insomnia', 'sym.night_symptoms'],
  speech: ['sym.speech_trouble', 'sym.transient_speech', 'sign.hoarse_voice', 'sign.nasal_speech', 'sign.speech_deficit'],
  face: [
    'sym.face_droop', 'sym.facial_pain', 'sym.perioral_paresthesia', 'sign.chvostek', 'sign.face_flushing',
    'sign.facial_palsy_peripheral', 'sign.facial_palsy_severe', 'sign.facial_weakness',
  ],
  weight: ['sym.weight_gain', 'sym.weight_loss', 'sign.obesity'],
  food: ['sym.anorexia', 'sym.appetite_high', 'sym.fatty_food', 'sym.hunger', 'hx.home_canned', 'hx.missed_meal'],
  thirst: ['sym.dry_mouth', 'sym.thirst', 'sign.dehydration', 'sign.dry_mucosa', 'sign.dry_skin'],
  temp: ['sym.fever_hx', 'sym.heat_intolerance', 'sym.sweating'],
  cold: ['sym.chills', 'sym.cold_intolerance', 'sign.cold_clammy'],
  spo2: ['sign.cyanosis'],
  pressure: ['sym.bp_surge', 'sym.high_bp_readings', 'sign.bp_arm_difference', 'hx.hypertension'],
  pulse: ['sign.pulse_irregular', 'sign.pulsus_paradoxus'],
  allergy: [
    'sign.angioedema', 'hx.allergy_nsaid', 'hx.allergy_penicillin', 'hx.antihistamine_failed', 'hx.atopy',
    'hx.trigger_drug', 'hx.trigger_food', 'hx.trigger_sting',
  ],
  trauma: ['sym.head_injury', 'sym.immediate_dysfunction', 'hx.calf_snap', 'hx.knee_blow', 'hx.knee_twist', 'hx.road_accident'],
  wound: ['sym.hand_wound', 'sym.head_wound', 'sign.wound_gaping', 'sign.wound_large', 'hx.wound_late'],
  burn: ['sym.burn', 'sign.burn_blisters', 'sign.burn_eschar', 'sign.burn_insensate', 'sign.burn_large'],
  bite: ['sym.animal_bite', 'hx.rodent_contact'],
  tick: ['sym.tick_bite', 'sign.tick_attached', 'hx.tick_bite_recent'],
  smoke: ['sym.co_home', 'sym.smoke_inhaled', 'sign.soot_face'],
  smoking: ['hx.smoking'],
  alcohol: ['sym.craving', 'sign.ciwa', 'sign.ciwa_16', 'hx.alcohol', 'hx.binge', 'hx.stopped_drinking'],
  meds: ['hx.antibiotic_now', 'hx.antibiotics_recent', 'hx.anticoagulants', 'hx.new_drug', 'hx.nsaid_use'],
  syringe: [
    'sign.injection_marks', 'hx.drug_use', 'hx.parenteral_risk', 'hx.tbe_vaccinated', 'hx.tetanus_recent',
    'hx.tetanus_records',
  ],
  chronic: ['hx.adrenal_insufficiency', 'hx.cancer_active'],
  scalpel: ['hx.abdominal_surgery', 'hx.thyroidectomy'],
  family: ['hx.family_crc', 'hx.jaundice_contact', 'hx.pregnancy', 'hx.sick_contact'],
  bag: ['hx.dust_work', 'hx.heavy_labor', 'hx.heavy_lifting', 'hx.outdoor_work', 'hx.travel'],
  bed: ['hx.bed_rest'],
  clock: ['sym.abrupt_onset', 'sym.double_worsening', 'hx.onset_hours', 'hx.seasonal_pain', 'hx.tick_hours'],
};

/** Расспрос, осмотр и обследования у постели — по теме и способу. */
export const EXAMS: Partial<Record<ItemIcon, readonly Id[]>> = {
  ask: ['exam.ask_complaints', 'exam.ask_general'],
  belly: ['exam.ask_abdomen', 'exam.abdomen_palpation', 'exam.hernia_check', 'exam.peritoneal_signs', 'exam.rectal_exam'],
  allergy: ['exam.ask_allergies', 'exam.ask_reaction'],
  back: ['exam.ask_back', 'exam.cva_percussion', 'exam.spine_exam'],
  chest: ['exam.ask_chest_pain', 'exam.chest_exam'],
  chronic: ['exam.ask_chronic'],
  family: ['exam.ask_contacts', 'exam.ask_family', 'exam.ask_pregnancy', 'exam.ask_witnesses'],
  food: ['exam.ask_food'],
  trauma: ['exam.ask_head_injury', 'exam.ask_injury'],
  headache: ['exam.ask_headache'],
  'sys.digestive': ['exam.ask_hepatitis'],
  foot: ['exam.ask_leg', 'exam.ankle_exam', 'exam.foot_exam', 'exam.hip_exam', 'exam.knee_exam', 'exam.knee_ligament_tests', 'exam.leg_exam'],
  smoking: ['exam.ask_lifestyle'],
  clock: ['exam.ask_lysis', 'exam.ask_onset'],
  meds: ['exam.ask_meds'],
  'sys.airways': ['exam.ask_nose', 'exam.nose_exam'],
  seizure: ['exam.ask_seizure'],
  'sys.nerves': ['exam.ask_stroke', 'exam.ask_tia'],
  syringe: ['exam.ask_tetanus', 'exam.lumbar_puncture', 'exam.paracentesis'],
  tick: ['exam.ask_tick', 'exam.tick_pcr'],
  'sys.urinary': ['exam.ask_urinary'],
  burn: ['exam.burn_depth_tests', 'exam.burn_exam'],
  alcohol: ['exam.ciwa'],
  'sys.bones': ['exam.clavicle_exam'],
  eye: ['exam.fundoscopy', 'exam.ice_test'],
  whole: ['exam.general_exam'],
  hand: ['exam.hand_function', 'exam.lung_percussion', 'exam.tetany_signs', 'exam.wrist_exam'],
  steth: ['exam.heart_auscultation', 'exam.lung_auscultation'],
  hammer: ['exam.neuro_exam'],
  throat: ['exam.throat', 'exam.thyroid_palpation', 'exam.swallow_test'],
  wound: ['exam.wound_exam'],
  pressure: ['exam.bp_both_arms'],
  'sys.metabolic': ['exam.glucometer'],
  breath: ['exam.peak_flow'],
  pulse: ['exam.pulsus_paradoxus'],
  bedside: ['exam.vitals'],
  stool: ['exam.cdiff_stool', 'exam.hp_stool'],
};

/** Обследования, которых нет в EXAMS: анализы, экспресс-тесты, ЭКГ и снимки — по способу и кабинету. */
const ROOM_ICONS: Record<string, ItemIcon> = {
  'room.xray': 'xray', 'room.ct': 'ct', 'room.mri': 'mri', 'room.ultrasound': 'us', 'room.endoscopy': 'scope', 'room.ecg': 'ecg',
};

/** Лечение, у которого значок не по пути введения: процедуры, режим, операции и особые лекарства. */
export const TREATMENTS: Partial<Record<ItemIcon, readonly Id[]>> = {
  oxygen: ['tx.oxygen_mask', 'tx.cpap'],
  'sys.lungs': ['tx.ventilation'],
  'sys.airways': ['tx.anterior_packing', 'tx.nasal_saline', 'tx.nasal_turunda', 'tx.nose_pinch'],
  'sys.bones': ['tx.arm_sling', 'tx.cast_splint', 'tx.chest_binding', 'tx.closed_reduction', 'tx.knee_brace', 'tx.rigid_shoe', 'tx.crutches'],
  'sys.heart': ['tx.cardioversion', 'tx.pacing_tc', 'tx.vagal'],
  wound: ['tx.wound_suture', 'tx.wound_open'],
  'sys.skin': ['tx.wound_dressing', 'tx.burn_dressing', 'tx.topical_heparin'],
  tick: ['tx.tick_removal'],
  clock: ['tx.tick_watch'],
  syringe: [
    'tx.pleural_drainage', 'tx.pleural_puncture', 'tx.pericardiocentesis', 'tx.paracentesis_large', 'tx.cholecystostomy',
    'tx.hip_block', 'tx.rib_block',
  ],
  scope: ['tx.endoscopic_hemostasis', 'tx.variceal_ligation'],
  'sys.poisoning': ['tx.gastric_lavage'],
  belly: ['tx.ng_tube'],
  blood: ['tx.blood_culture', 'tx.cortisol_sample', 'tx.pth_sample'],
  stool: ['tx.stool_culture'],
  steth: ['tx.coloproctologist_consult', 'tx.narcologist_consult', 'tx.nsg_consult'],
  bed: ['tx.bed_rest', 'tx.rest_fluids', 'tx.rice'],
  breath: ['tx.breathing_exercises'],
  foot: ['tx.compression', 'tx.stay_active'],
  food: ['tx.liver_diet', 'tx.low_salt_diet', 'tx.fast_carbs'],
  weight: ['tx.lifestyle'],
  sleep: ['tx.screen_rest'],
  meds: ['tx.stop_antibiotic', 'tx.stop_nsaid'],
  thirst: ['tx.ors'],
  pill: ['tx.hp_eradication', 'tx.chloramphenicol'],
  eye: ['tx.eye_lubricant'],
  spray: ['tx.interferon_a2b'],
};

/** Путь введения лекарства → значок. */
const ROUTE_ICONS: Record<string, ItemIcon> = { oral: 'pill', iv: 'drip', im: 'syringe', sc: 'syringe', inhaled: 'inhaler', nasal: 'spray' };

/** Болезни без своей системы органов — хронические, что идут фоном: по органу. */
const CONDITION_SYSTEMS: Record<Id, BodySystem> = {
  'cond.asthma': 'lungs', 'cond.copd': 'lungs', 'cond.diabetes2': 'metabolic', 'cond.hypertension': 'heart',
};

function invert(table: Partial<Record<ItemIcon, readonly Id[]>>): Map<Id, ItemIcon> {
  const m = new Map<Id, ItemIcon>();
  for (const [icon, ids] of Object.entries(table) as [ItemIcon, readonly Id[]][]) for (const id of ids) m.set(id, icon);
  return m;
}

const findingTable = invert(FINDINGS);
const examTable = invert(EXAMS);
const treatmentTable = invert(TREATMENTS);

export function examIcon(id: Id): ItemIcon {
  const own = examTable.get(id);
  if (own) return own;
  const e = db.exams[id];
  if (!e) return 'ask';
  if (e.kind === 'imaging' || e.kind === 'functional') return ROOM_ICONS[e.room ?? ''] ?? 'xray';
  if (/urin/.test(id)) return 'urine';
  if (e.kind === 'rapid') return 'rapid';
  if (e.kind === 'lab') return 'blood';
  if (e.kind === 'bedside') return 'bedside';
  if (e.kind === 'physical') return 'steth';
  return 'ask';
}

const VITALS: [RegExp, ItemIcon][] = [[/^vital\.bp_/, 'pressure'], [/cardia/, 'pulse'], [/pnea|pef/, 'breath'], [/fever/, 'temp'], [/spo2/, 'spo2']];

export function findingIcon(id: Id): ItemIcon {
  const own = findingTable.get(id);
  if (own) return own;
  const f = db.findings[id];
  if (f?.kind === 'vital') return VITALS.find(([re]) => re.test(id))?.[1] ?? 'pulse';
  if (f?.kind === 'ecg') return 'ecg';
  const by = db.revealedBy?.[id]?.[0];
  if (by) return examIcon(by);
  return f?.kind === 'hx' ? 'chronic' : 'ask';
}

export function treatmentIcon(id: Id): ItemIcon {
  const own = treatmentTable.get(id);
  if (own) return own;
  const t = db.treatments[id];
  if (!t) return 'pill';
  if (t.kind === 'surgery') return 'scalpel';
  return ROUTE_ICONS[t.route ?? ''] ?? (t.kind === 'regimen' ? 'bed' : 'pill');
}

export function conditionIcon(id: Id): ItemIcon {
  const system = db.conditions[id]?.system ?? CONDITION_SYSTEMS[id];
  return system ? `sys.${system}` : 'chronic';
}
