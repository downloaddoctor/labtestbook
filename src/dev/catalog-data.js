// Dev-only realistic catalog data: 130+ lab tests, 2 labs, 2 doctors.
// Prices are typical Indian private-lab rates (customer = walk-in, merchant = referred).
// Loaded only by src/dev/seed.js under ?dev=1. Never imported from prod paths.

export const SAMPLE_TESTS = [
  // ---------- Hematology ----------
  { name: 'CBC (Complete Blood Count)', sell: 350, buy: 250 },
  { name: 'Hemoglobin (Hb)', sell: 100, buy: 60 },
  { name: 'Total WBC Count (TLC)', sell: 120, buy: 70 },
  { name: 'Differential Count (DC)', sell: 150, buy: 90 },
  { name: 'Platelet Count', sell: 150, buy: 90 },
  { name: 'ESR', sell: 100, buy: 60 },
  { name: 'PCV / Hematocrit', sell: 120, buy: 70 },
  { name: 'MCV / MCH / MCHC', sell: 200, buy: 130 },
  { name: 'Reticulocyte Count', sell: 250, buy: 160 },
  { name: 'Peripheral Blood Smear', sell: 300, buy: 200 },
  { name: 'Absolute Eosinophil Count', sell: 180, buy: 110 },
  { name: 'PT / INR', sell: 400, buy: 280 },
  { name: 'APTT', sell: 400, buy: 280 },
  { name: 'D-Dimer', sell: 1200, buy: 850 },
  { name: 'Blood Group & Rh Typing', sell: 150, buy: 90 },
  { name: 'Coomb\'s Test (Direct)', sell: 500, buy: 350 },
  { name: 'HbA1c (Glycated Hemoglobin)', sell: 450, buy: 320 },
  { name: 'Fasting Blood Sugar (FBS)', sell: 80, buy: 50 },
  { name: 'Post Prandial Blood Sugar (PPBS)', sell: 80, buy: 50 },
  { name: 'Random Blood Sugar (RBS)', sell: 70, buy: 45 },

  // ---------- Diabetes / Endocrine ----------
  { name: 'Fasting Insulin', sell: 700, buy: 500 },
  { name: 'C-Peptide', sell: 1200, buy: 850 },
  { name: 'Thyroid Profile (T3, T4, TSH)', sell: 700, buy: 500 },
  { name: 'TSH (Ultrasensitive)', sell: 350, buy: 250 },
  { name: 'Free T3 (FT3)', sell: 400, buy: 280 },
  { name: 'Free T4 (FT4)', sell: 400, buy: 280 },
  { name: 'Anti-TPO Antibodies', sell: 900, buy: 650 },
  { name: 'Cortisol (Morning)', sell: 800, buy: 550 },
  { name: 'ACTH', sell: 1100, buy: 800 },
  { name: 'Prolactin', sell: 650, buy: 450 },
  { name: 'FSH', sell: 600, buy: 420 },
  { name: 'LH', sell: 600, buy: 420 },
  { name: 'Testosterone (Total)', sell: 900, buy: 650 },
  { name: 'Estradiol (E2)', sell: 900, buy: 650 },
  { name: 'Progesterone', sell: 800, buy: 550 },
  { name: 'Beta HCG (Quantitative)', sell: 900, buy: 650 },
  { name: 'Vitamin D (25-OH)', sell: 1200, buy: 850 },
  { name: 'Vitamin B12', sell: 900, buy: 650 },
  { name: 'Parathyroid Hormone (PTH)', sell: 1100, buy: 800 },

  // ---------- Lipid Profile ----------
  { name: 'Lipid Profile', sell: 600, buy: 420 },
  { name: 'Total Cholesterol', sell: 180, buy: 120 },
  { name: 'Triglycerides', sell: 180, buy: 120 },
  { name: 'HDL Cholesterol', sell: 200, buy: 130 },
  { name: 'LDL Cholesterol', sell: 200, buy: 130 },
  { name: 'VLDL Cholesterol', sell: 200, buy: 130 },
  { name: 'Apolipoprotein A1', sell: 900, buy: 650 },
  { name: 'Apolipoprotein B', sell: 900, buy: 650 },
  { name: 'Lipoprotein (a)', sell: 1100, buy: 800 },

  // ---------- Liver Function ----------
  { name: 'Liver Function Test (LFT)', sell: 700, buy: 480 },
  { name: 'Bilirubin Total', sell: 200, buy: 130 },
  { name: 'Bilirubin Direct', sell: 200, buy: 130 },
  { name: 'Bilirubin Indirect', sell: 200, buy: 130 },
  { name: 'SGOT (AST)', sell: 200, buy: 130 },
  { name: 'SGPT (ALT)', sell: 200, buy: 130 },
  { name: 'Alkaline Phosphatase (ALP)', sell: 250, buy: 160 },
  { name: 'GGT (Gamma GT)', sell: 350, buy: 240 },
  { name: 'Total Protein', sell: 200, buy: 130 },
  { name: 'Albumin', sell: 200, buy: 130 },
  { name: 'Globulin', sell: 200, buy: 130 },
  { name: 'A/G Ratio', sell: 200, buy: 130 },

  // ---------- Kidney Function ----------
  { name: 'Kidney Function Test (KFT)', sell: 750, buy: 500 },
  { name: 'Blood Urea', sell: 200, buy: 130 },
  { name: 'Blood Urea Nitrogen (BUN)', sell: 200, buy: 130 },
  { name: 'Serum Creatinine', sell: 250, buy: 160 },
  { name: 'Uric Acid', sell: 250, buy: 160 },
  { name: 'eGFR', sell: 300, buy: 200 },
  { name: 'Serum Sodium', sell: 200, buy: 130 },
  { name: 'Serum Potassium', sell: 200, buy: 130 },
  { name: 'Serum Chloride', sell: 200, buy: 130 },
  { name: 'Serum Calcium', sell: 250, buy: 160 },
  { name: 'Serum Phosphorus', sell: 250, buy: 160 },
  { name: 'Serum Magnesium', sell: 300, buy: 200 },

  // ---------- Cardiac / Inflammation ----------
  { name: 'hs-CRP', sell: 700, buy: 500 },
  { name: 'CRP (Quantitative)', sell: 500, buy: 350 },
  { name: 'Troponin I', sell: 1200, buy: 850 },
  { name: 'CK-MB', sell: 900, buy: 650 },
  { name: 'Homocysteine', sell: 1100, buy: 800 },
  { name: 'BNP / NT-proBNP', sell: 1800, buy: 1300 },
  { name: 'LDH', sell: 300, buy: 200 },
  { name: 'CPK (Total)', sell: 400, buy: 280 },

  // ---------- Infection / Serology ----------
  { name: 'Widal Test', sell: 250, buy: 160 },
  { name: 'Typhidot IgM', sell: 500, buy: 350 },
  { name: 'Dengue NS1 Antigen', sell: 700, buy: 500 },
  { name: 'Dengue IgG / IgM', sell: 700, buy: 500 },
  { name: 'Malaria Antigen (Pf/Pv)', sell: 400, buy: 280 },
  { name: 'Malaria Parasite (Smear)', sell: 250, buy: 160 },
  { name: 'Chikungunya IgM', sell: 700, buy: 500 },
  { name: 'Typhoid IgM', sell: 500, buy: 350 },
  { name: 'HBsAg (Qualitative)', sell: 400, buy: 280 },
  { name: 'Anti-HCV', sell: 500, buy: 350 },
  { name: 'HIV I & II (ELISA)', sell: 500, buy: 350 },
  { name: 'VDRL / RPR', sell: 250, buy: 160 },
  { name: 'TPHA', sell: 500, buy: 350 },
  { name: 'CRP (Qualitative)', sell: 300, buy: 200 },
  { name: 'RA Factor (Quantitative)', sell: 500, buy: 350 },
  { name: 'ASO Titre', sell: 400, buy: 280 },
  { name: 'COVID-19 IgG Antibody', sell: 700, buy: 500 },
  { name: 'H. Pylori Antigen (Stool)', sell: 800, buy: 550 },
  { name: 'H. Pylori IgG', sell: 700, buy: 500 },

  // ---------- Urine / Stool ----------
  { name: 'Urine Routine & Microscopy', sell: 150, buy: 90 },
  { name: 'Urine Culture & Sensitivity', sell: 700, buy: 500 },
  { name: 'Urine Protein (24 hr)', sell: 400, buy: 280 },
  { name: 'Urine Microalbumin', sell: 500, buy: 350 },
  { name: 'Urine Pregnancy Test (UPT)', sell: 150, buy: 90 },
  { name: 'Stool Routine & Microscopy', sell: 200, buy: 130 },
  { name: 'Stool Occult Blood', sell: 300, buy: 200 },
  { name: 'Stool Culture', sell: 800, buy: 550 },

  // ---------- Vitamins / Minerals ----------
  { name: 'Serum Iron', sell: 400, buy: 280 },
  { name: 'Total Iron Binding Capacity (TIBC)', sell: 500, buy: 350 },
  { name: 'Ferritin', sell: 900, buy: 650 },
  { name: 'Serum Folate', sell: 900, buy: 650 },
  { name: 'Serum Zinc', sell: 900, buy: 650 },
  { name: 'Serum Copper', sell: 900, buy: 650 },

  // ---------- Tumor Markers ----------
  { name: 'PSA (Total)', sell: 800, buy: 550 },
  { name: 'PSA (Free)', sell: 900, buy: 650 },
  { name: 'CEA', sell: 900, buy: 650 },
  { name: 'CA-125', sell: 1100, buy: 800 },
  { name: 'CA 19-9', sell: 1100, buy: 800 },
  { name: 'CA 15-3', sell: 1100, buy: 800 },
  { name: 'AFP (Alpha Fetoprotein)', sell: 900, buy: 650 },
  { name: 'Beta-2 Microglobulin', sell: 1200, buy: 850 },

  // ---------- Autoimmune ----------
  { name: 'ANA (Antinuclear Antibody)', sell: 1200, buy: 850 },
  { name: 'Anti-dsDNA', sell: 1300, buy: 950 },
  { name: 'Anti-CCP', sell: 1400, buy: 1000 },
  { name: 'ANCA (c/p)', sell: 1500, buy: 1100 },
  { name: 'Celiac Antibody (tTG IgA)', sell: 1400, buy: 1000 },
  { name: 'Anti-Phospholipid Antibody', sell: 1300, buy: 950 },

  // ---------- Hormones / Misc ----------
  { name: 'Serum Electrolytes', sell: 400, buy: 280 },
  { name: 'Serum Amylase', sell: 400, buy: 280 },
  { name: 'Serum Lipase', sell: 450, buy: 320 },
  { name: 'Ammonia (Blood)', sell: 700, buy: 500 },
  { name: 'Lactate (Blood)', sell: 700, buy: 500 },
  { name: 'Serum Procalcitonin', sell: 1800, buy: 1300 },
  { name: 'Serum ACE', sell: 1200, buy: 850 },
  { name: 'Serum Total IgE', sell: 900, buy: 650 },
  { name: 'Allergy Panel (Food, 20 allergens)', sell: 3500, buy: 2600 },
  { name: 'Allergy Panel (Inhalant, 20 allergens)', sell: 3500, buy: 2600 },
];

export const LABS = ['Reliable', 'Metro Labs'];

export const DOCTORS = ['Dr. Manish Goyal', 'Dr. A. Banerjee'];

