/** Fictional, deterministic content shared by the theme gallery and renderer tests. */
export const DOCUMENT_PREVIEW_CV = {
  contract_version: "1.0.0",
  candidate: {
    name: "Taylor Example",
    email: "taylor@example.test",
    phone: "+44 7700 900000",
    location: "Manchester",
    linkedin: "linkedin.com/in/taylorexample",
  },
  target: { job_id: "88888888-8888-4888-8888-888888888888", company: "Fixture Engineering", title: "Simulation Engineer" },
  headline: "Engineering researcher",
  profile_summary: {
    text: "Engineer with verified modelling and research experience, focused on validated numerical methods and clear technical communication.",
  },
  sections: [
    {
      section_key: "experience",
      heading: "Experience",
      entries: [
        {
          heading: "Senior Research Engineer", subheading: "Fixture Engineering Group", date: "2022–2025", location: "Manchester",
          bullets: [
            "Built a Python finite-element model that compared design alternatives against measured reference data before a prototype release.",
            "Introduced repeatable validation checks and documented model assumptions, reducing avoidable rework during engineering reviews.",
            "Presented uncertainty and sensitivity findings to mechanical engineers, helping the team prioritise the tests with the greatest decision value.",
          ],
        },
        {
          heading: "Research Associate", subheading: "North West Applied Research Centre", date: "2019–2022", location: "Manchester",
          bullets: [
            "Analysed experimental and simulated datasets in Python, checking data quality before drawing conclusions from model outputs.",
            "Worked with cross-disciplinary collaborators to translate research questions into testable engineering studies and clear reports.",
            "Maintained traceable records of analysis steps, limitations, and decisions so that findings could be independently reviewed.",
          ],
        },
        {
          heading: "Mechanical Design Engineer", subheading: "Meridian Product Systems", date: "2016–2019", location: "Leeds",
          bullets: [
            "Supported product design reviews with calculations, test interpretation, and concise evidence for engineering recommendations.",
            "Collaborated with manufacturing and quality colleagues to resolve technical questions and communicate practical constraints.",
            "Created reusable analysis notes that made assumptions and sources visible to future project teams.",
          ],
        },
        {
          heading: "Graduate Engineer", subheading: "Meridian Product Systems", date: "2014–2016", location: "Leeds",
          bullets: [
            "Prepared engineering calculations and checked results against design requirements under the guidance of senior colleagues.",
            "Summarised test observations and technical findings for project files and internal design discussions.",
          ],
        },
      ],
    },
    {
      section_key: "skills", heading: "Technical Skills", entries: [{ heading: "Engineering and Computing", bullets: [
        "Python, numerical modelling, finite-element methods, data analysis, model validation and reproducible workflows.",
        "Technical reporting, uncertainty communication, design review support and cross-functional collaboration.",
      ] }],
    },
    {
      section_key: "projects", heading: "Selected Technical Work", entries: [
        { heading: "Thermal performance model", subheading: "Applied Engineering Study", date: "2021–2022", bullets: [
          "Compared simulated thermal behaviour with test evidence and recorded the limits of the model before recommending design changes.",
          "Used Python to make the analysis repeatable and to communicate which parameters most affected the result.",
          "Prepared a concise technical summary that enabled reviewers to trace the recommendation to its supporting evidence.",
        ] },
        { heading: "Vibration-test correlation", subheading: "Product Engineering Study", date: "2018–2019", bullets: [
          "Compared vibration-test observations with model predictions and documented the conditions that affected correlation.",
          "Summarised the findings for a design review, separating measured results from assumptions and open questions.",
        ] },
        { heading: "Reusable analysis workflow", subheading: "Research Engineering", date: "2020–2021", bullets: [
          "Organised Python analysis steps so input data, validation checks, and plotted results could be reviewed consistently.",
          "Recorded sensitivity findings and limitations alongside conclusions to support reproducible technical decisions.",
        ] },
      ],
    },
    {
      section_key: "education", heading: "Education and Development", entries: [
        { heading: "PhD, Mechanical Engineering", subheading: "University of Manchester", date: "2016–2020", bullets: ["Research focused on numerical modelling, validation, and interpretation of engineering evidence."] },
        { heading: "MEng, Mechanical Engineering", subheading: "University of Leeds", date: "2010–2014", bullets: ["Integrated master's degree with an engineering design and analysis focus."] },
      ],
    },
    {
      section_key: "publications", heading: "Research Communication", entries: [{
        heading: "Engineering modelling and validation", subheading: "Technical reports and research presentations", date: "2019–2024",
        bullets: [
          "Presented modelling assumptions, validation evidence, uncertainty, and practical implications to engineering and research audiences.",
          "Prepared concise written summaries that connected technical analysis to recommendations and clearly stated limitations.",
        ],
      }],
    },
  ],
  unsupported_claims: [],
};

const paragraphs = [
  "I am applying for the Simulation Engineer position because its focus on validated numerical modelling matches the engineering and research work I have carried out. My experience includes building computational models, examining their assumptions, and using reference evidence to understand where their conclusions are reliable. I am interested in applying that careful approach to the design questions facing Fixture Engineering.",
  "In my recent research engineering work, I used Python and finite-element methods to compare design alternatives with measured data. I introduced repeatable checks and documented uncertainty so that colleagues could assess both the findings and their limitations. This helped technical reviews stay focused on evidence and on the tests most likely to change a decision.",
  "Earlier roles strengthened my ability to work across design, manufacturing, and research teams. I prepared calculations and reports, discussed practical constraints, and made the reasoning behind recommendations clear to different audiences. I would bring that combination of analytical discipline and collaborative communication to your engineering projects.",
  "The opportunity particularly appeals to me because rigorous modelling is most valuable when it informs practical engineering choices. I would contribute a methodical, open approach, build on the verified skills in my background, and learn the team's specific tools and processes. I would welcome the chance to discuss how this experience could support Fixture Engineering's work.",
];

export const DOCUMENT_PREVIEW_LETTER = {
  candidate_name: "Taylor Example",
  candidate_email: "taylor@example.test",
  candidate_phone: "+44 7700 900000",
  candidate_location: "Manchester",
  company: "Fixture Engineering",
  job_title: "Simulation Engineer",
  salutation: "Dear Hiring Manager,",
  paragraphs: paragraphs.map((text) => ({ text })),
  closing: "Yours sincerely,",
  plaintext: ["Dear Hiring Manager,", ...paragraphs, "Yours sincerely,", "Taylor Example"].join("\n\n"),
  unsupported_claims: [],
};
