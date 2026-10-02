import { randomBytes } from "node:crypto";
import argon2 from "argon2";
import { PrismaClient, Role } from "@prisma/client";

const prisma = new PrismaClient();

const syllabus = [
  {
    title: "Introduction to Hydrocarbons and Crude Oil",
    outcomes: [
      "Origin of crude oil and natural gas",
      "Sources of hydrocarbons and world crude oil reserves",
      "Crude oil exploration, drilling, refining, fractions and petrochemicals"
    ],
    questions: [
      ["Crude oil and natural gas formed mainly from:", ["Ancient marine organisms buried under sediment", "Fresh volcanic lava", "Pure sand exposed to sunlight", "Modern plant leaves"], 0, "Buried remains of ancient organisms were transformed by heat and pressure over geological time."],
      ["A major component of natural gas is:", ["Methane", "Ethanol", "Sodium chloride", "Carbon monoxide"], 0, "Natural gas consists mainly of methane, with smaller amounts of other gases."],
      ["In fractional distillation, crude oil fractions are separated mainly by differences in their:", ["Boiling-point ranges", "Colours", "Electrical charges", "Densities only"], 0, "Fractions condense at different levels because their hydrocarbons have different boiling-point ranges."],
      ["Which product is commonly obtained from the lightest crude-oil fractions?", ["Refinery gas", "Bitumen", "Lubricating oil", "Wax"], 0, "Small hydrocarbon molecules have low boiling points and leave near the top of the fractionating column."]
    ]
  },
  {
    title: "General Introduction to Organic Chemistry",
    outcomes: [
      "Definition and importance of organic chemistry",
      "Brief history and development of organic chemistry",
      "Terms in organic chemistry and types of organic compounds"
    ],
    questions: [
      ["Organic chemistry primarily studies compounds of:", ["Carbon", "Sodium", "Helium", "Silicon only"], 0, "Organic chemistry is the study of carbon compounds, especially those containing carbon-hydrogen bonds."],
      ["The term 'homologous series' describes compounds with the same functional group and:", ["A common general formula and gradual changes in properties", "Identical molecular masses", "Only one carbon atom", "No chemical reactions"], 0, "Members of a homologous series share a functional group and general formula, with successive members differing by CH2."],
      ["Which formula is an empirical formula?", ["CH2", "C2H4", "C3H6", "C4H8"], 0, "CH2 is the simplest whole-number ratio of carbon to hydrogen in the other formulas."],
      ["A functional group is the part of a molecule that mainly determines its:", ["Characteristic chemical reactions", "Number of neutrons", "Nuclear charge", "Isotope abundance"], 0, "Functional groups give families of organic compounds their characteristic reactions."]
    ]
  },
  {
    title: "Atomic Structure and Bonding",
    outcomes: [
      "Atomic orbitals and hybridization",
      "Ionic, covalent and hydrogen bonding",
      "Electron configuration and molecular shape"
    ],
    questions: [
      ["A carbon atom in methane is commonly described as:", ["sp3 hybridized", "sp hybridized", "sp2 hybridized", "Unhybridized only"], 0, "Carbon forms four equivalent bonds in methane using sp3 hybrid orbitals."],
      ["A covalent bond forms when atoms:", ["Share a pair of electrons", "Transfer a proton", "Share neutrons", "Lose all their electrons"], 0, "Covalent bonding involves a shared pair of electrons."],
      ["The shape of a methane molecule is:", ["Tetrahedral", "Linear", "Trigonal planar", "Square planar"], 0, "Four bonding pairs around carbon arrange tetrahedrally."],
      ["A hydrogen bond is best described as an attraction involving hydrogen bonded to:", ["A strongly electronegative atom", "Any metal atom", "A noble gas", "Another carbon only"], 0, "Hydrogen bonding commonly occurs when hydrogen is bonded to N, O or F and is attracted to a lone pair."]
    ]
  },
  {
    title: "Functional Groups and Nomenclature",
    outcomes: [
      "IUPAC nomenclature of complex organic molecules",
      "Common functional groups: alkanes, alkenes and alkynes",
      "Common functional groups: aromatics"
    ],
    questions: [
      ["The IUPAC name for CH3CH2OH is:", ["Ethanol", "Methanol", "Ethanal", "Ethene"], 0, "The two-carbon alcohol is named ethanol."],
      ["The suffix used for an alkene is:", ["-ene", "-ane", "-yne", "-ol"], 0, "Alkenes contain a carbon-carbon double bond and use the suffix -ene."],
      ["The functional group of an alkyne is:", ["Carbon-carbon triple bond", "Carbon-oxygen double bond", "Hydroxyl group", "Amino group"], 0, "Alkynes contain at least one carbon-carbon triple bond."],
      ["Benzene is classified as:", ["An aromatic hydrocarbon", "An alcohol", "An ether", "An amine"], 0, "Benzene is the simplest aromatic hydrocarbon."]
    ]
  },
  {
    title: "Stereochemistry",
    outcomes: [
      "Chiral atoms and enantiomers",
      "Geometric isomerism and conformational analysis",
      "Structure determination of organic compounds"
    ],
    questions: [
      ["A tetrahedral carbon is usually chiral when it is attached to:", ["Four different groups", "Four hydrogen atoms", "Two pairs of identical groups", "Three double bonds"], 0, "A carbon attached to four different substituents has non-superimposable mirror images."],
      ["Enantiomers are:", ["Non-superimposable mirror images", "Identical atoms with different masses", "Compounds with different formulas", "Conformers that rotate freely"], 0, "Enantiomers are stereoisomers that are mirror images but cannot be superimposed."],
      ["Geometric isomerism in an alkene arises because the double bond:", ["Restricts rotation", "Allows free rotation", "Contains ionic bonds", "Always breaks apart"], 0, "The pi bond prevents free rotation around the carbon-carbon double bond."],
      ["Which method can provide information about functional groups in a molecule?", ["Infrared spectroscopy", "Filtration only", "Decantation", "Magnetic separation"], 0, "Infrared spectroscopy detects characteristic bond vibrations and can identify functional groups."]
    ]
  },
  {
    title: "Organic Reactions",
    outcomes: [
      "Addition, elimination, substitution and rearrangement",
      "Reaction mechanisms and conditions"
    ],
    questions: [
      ["In an addition reaction, atoms or groups are added across a:", ["Multiple bond", "Single C-C bond only", "Nucleus", "Hydrogen bond"], 0, "Addition reactions commonly convert a carbon-carbon double or triple bond into single bonds."],
      ["In a substitution reaction, one atom or group is:", ["Replaced by another", "Always removed to form a double bond", "Added across a double bond", "Converted into a neutron"], 0, "Substitution replaces an atom or functional group with another."],
      ["An elimination reaction often forms a:", ["Double bond", "New isotope", "Salt bridge", "Noble gas"], 0, "Elimination removes atoms or groups from neighbouring atoms, often creating a multiple bond."],
      ["A reaction mechanism describes:", ["The sequence of bond-making and bond-breaking steps", "Only the colour of products", "The mass of the reaction vessel", "The boiling point of water"], 0, "A mechanism shows how a reaction proceeds step by step."]
    ]
  },
  {
    title: "Hydrocarbons and Their Reactions",
    outcomes: [
      "Alkanes, alkenes, alkynes and aromatics",
      "Combustion, addition and other hydrocarbon reactions"
    ],
    questions: [
      ["The general formula for an acyclic alkane is:", ["CnH2n+2", "CnH2n", "CnHn", "CnH2n-2"], 0, "Acyclic alkanes have the general formula CnH2n+2."],
      ["Bromine water is decolourised by ethene because ethene undergoes:", ["Addition across its double bond", "Neutralisation", "Precipitation", "Combustion in water"], 0, "Ethene adds bromine across the carbon-carbon double bond, removing the bromine colour."],
      ["Complete combustion of a hydrocarbon produces:", ["Carbon dioxide and water", "Carbon and hydrogen", "Nitrogen and water", "Carbon monoxide only"], 0, "With sufficient oxygen, hydrocarbon carbon and hydrogen form carbon dioxide and water."],
      ["Ethene can be converted to ethane by adding:", ["Hydrogen", "Oxygen", "Chlorine water", "Sodium hydroxide"], 0, "Hydrogenation adds H2 across the double bond, usually using a catalyst."]
    ]
  },
  {
    title: "Alcohols, Ethers, and Phenols",
    outcomes: [
      "Structures and properties of alcohols, ethers and phenols",
      "Reactions of alcohols, ethers and phenols"
    ],
    questions: [
      ["The functional group in an alcohol is:", ["-OH attached to a saturated carbon", "-CHO", "-COOH", "-NH2"], 0, "Alcohols contain a hydroxyl group bonded to a saturated carbon atom."],
      ["Ethanol can be oxidised under suitable conditions to:", ["Ethanal", "Ethene only", "Ethane", "Methane"], 0, "Controlled oxidation of ethanol can produce ethanal."],
      ["An ether contains an oxygen atom bonded between:", ["Two carbon groups", "Two nitrogen atoms", "Two metal ions", "A carbon and a halogen only"], 0, "Ethers have the general structure R-O-R'."],
      ["Phenol is more acidic than a typical alcohol mainly because its conjugate base is:", ["Stabilized by resonance", "A noble gas", "Unable to contain electrons", "Always positively charged"], 0, "The phenoxide ion is resonance-stabilized, making phenol more acidic than ordinary alcohols."]
    ]
  },
  {
    title: "Carbonyl Compounds",
    outcomes: [
      "Aldehydes and ketones",
      "Carboxylic acids and their derivatives"
    ],
    questions: [
      ["The carbonyl group is:", ["C=O", "C=C", "C≡C", "O-O"], 0, "A carbonyl group contains a carbon-oxygen double bond."],
      ["An aldehyde has its carbonyl carbon bonded to at least one:", ["Hydrogen atom", "Nitrogen atom", "Metal atom", "Halogen molecule"], 0, "Aldehydes contain the -CHO group, with a hydrogen attached to the carbonyl carbon."],
      ["A ketone has a carbonyl carbon bonded to:", ["Two carbon groups", "Two hydrogen atoms only", "A metal and a halogen", "Three oxygen atoms"], 0, "In a ketone, the carbonyl carbon lies between two carbon groups."],
      ["The functional group of a carboxylic acid is:", ["-COOH", "-OH only", "-O-", "-NH2"], 0, "Carboxylic acids contain the carboxyl group, -COOH."]
    ]
  },
  {
    title: "Amines and Other Nitrogen Compounds",
    outcomes: [
      "Structures and properties of amines",
      "Reactions of amines and other nitrogen compounds"
    ],
    questions: [
      ["A primary amine has nitrogen attached to:", ["One carbon group", "Two carbon groups", "Three carbon groups", "No hydrogen atoms"], 0, "A primary amine has one organic group and two hydrogens attached to nitrogen."],
      ["Amines are generally basic because nitrogen has:", ["A lone pair of electrons", "No valence electrons", "A carbonyl double bond", "A positive nucleus only"], 0, "The nitrogen lone pair can accept a proton, giving amines basic properties."],
      ["The functional group of an amide includes:", ["A carbonyl attached to nitrogen", "An oxygen between two alkyl groups", "A carbon-carbon triple bond", "A hydroxyl group only"], 0, "Amides contain a carbonyl group bonded directly to nitrogen."],
      ["When an amine accepts a proton, it forms:", ["An ammonium ion", "An alkene", "A ketone", "A hydrocarbon"], 0, "Protonation of an amine forms a positively charged ammonium species."]
    ]
  }
];

const username = (process.env.ADMIN_USERNAME ?? "admin").trim().toLowerCase();

async function main(): Promise<void> {
  let admin = await prisma.user.findUnique({ where: { username } });
  if (!admin) {
    const temporaryPassword = randomBytes(9).toString("base64url");
    admin = await prisma.user.create({
      data: {
        username,
        displayName: "Administrator",
        passwordHash: await argon2.hash(temporaryPassword),
        mustChangePassword: true,
        role: Role.ADMIN
      }
    });
    console.log(`First-run administrator: ${username}`);
    console.log(`One-time password: ${temporaryPassword}`);
    console.log("Change this password immediately after signing in.");
  }

  const classes = await Promise.all(["SS1", "SS2"].map((name) =>
    prisma.class.upsert({ where: { name }, update: {}, create: { name } })
  ));

  for (let index = 1; index <= 10; index += 1) {
    const classRecord = classes[index <= 5 ? 0 : 1]!;
    const studentUsername = `student${String(index).padStart(2, "0")}`;
    const existing = await prisma.user.findUnique({ where: { username: studentUsername } });
    if (!existing) {
      const temporaryPassword = randomBytes(6).toString("base64url").slice(0, 8);
      const student = await prisma.user.create({
        data: {
          username: studentUsername,
          displayName: `Student ${String(index).padStart(2, "0")}`,
          passwordHash: await argon2.hash(temporaryPassword),
          mustChangePassword: true,
          role: Role.STUDENT,
          enrollments: { create: { classId: classRecord.id } }
        }
      });
      console.log(`Seed login slip: ${student.username} / ${temporaryPassword}`);
    }
  }

  let questionCount = await prisma.question.count();
  if (questionCount === 0) {
    for (const [chapterIndex, chapter] of syllabus.entries()) {
      const parent = await prisma.topic.create({
        data: { title: chapter.title, description: chapter.outcomes.join("; "), sourceOrder: chapterIndex + 1 }
      });
      const outcomes = await Promise.all(chapter.outcomes.map((outcome, outcomeIndex) =>
        prisma.topic.create({
          data: { title: outcome, parentId: parent.id, sourceOrder: outcomeIndex + 1 }
        })
      ));
      for (const [questionIndex, [stem, optionTexts, correctIndex, explanation]] of chapter.questions.entries()) {
        const topic = outcomes[questionIndex % outcomes.length]!;
        const options = optionTexts.map((text, optionIndex) => ({ id: String.fromCharCode(97 + optionIndex), text }));
        await prisma.question.create({
          data: {
            stem,
            type: "SINGLE",
            options: JSON.stringify(options),
            correctOptionIds: JSON.stringify([String.fromCharCode(97 + correctIndex!)]),
            explanation,
            topicId: topic.id,
            difficulty: 1 + (questionIndex % 3),
            tags: JSON.stringify(["seed", "organic-chemistry"]),
            status: "APPROVED",
            source: "manual"
          }
        });
      }
    }
    questionCount = await prisma.question.count();
  }

  await prisma.setting.upsert({
    where: { key: "branding" },
    update: {},
    create: {
      key: "branding",
      value: JSON.stringify({
        schoolName: "ChemArena",
        primaryColor: "#193b6a",
        accentColor: "#16a085",
        footerLine: "Learn, practise, compete.",
        logoDataUrl: null
      })
    }
  });
  console.log(`Seed ready: ${classes.length} classes, ${questionCount} questions, ${syllabus.length} syllabus chapters.`);
}

main()
  .catch((error: unknown) => {
    console.error("ChemArena seed failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
