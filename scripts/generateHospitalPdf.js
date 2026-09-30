const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");

/**
 * Generates the official City Care Hospital & Doctors Directory PDF.
 * Uses standard typography and bilingual English/Hindi Romanized format
 * so it is universally readable by any PDF viewer and extracts 100% clean text.
 */
function generateHospitalPdf(outputPath) {
  const targetPath =
    outputPath || path.join(__dirname, "..", "data", "hospital_and_doctors.pdf");

  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: "A4" });
    const writeStream = fs.createWriteStream(targetPath);

    doc.pipe(writeStream);

    // Header Box
    doc.rect(40, 40, 515, 60).fill("#1a365d");

    doc
      .fillColor("#ffffff")
      .fontSize(20)
      .font("Helvetica-Bold")
      .text("CITY CARE HOSPITAL (City Care Hospital, Kanpur)", 50, 52, { align: "center", width: 495 });

    doc
      .fontSize(11)
      .font("Helvetica")
      .fillColor("#e2e8f0")
      .text("Official Hospital & Doctors Directory - Single Source of Truth", 50, 78, {
        align: "center",
        width: 495,
      });

    doc.moveDown(2);

    // Section 1: Hospital Overview
    doc
      .fillColor("#1a365d")
      .fontSize(13)
      .font("Helvetica-Bold")
      .text("1. HOSPITAL GENERAL INFORMATION & CONTACT DETAILS");

    doc
      .strokeColor("#cbd5e1")
      .lineWidth(1)
      .moveTo(40, doc.y + 2)
      .lineTo(555, doc.y + 2)
      .stroke();

    doc.moveDown(0.6);

    const hospitalDetails = [
      ["Hospital Name:", "City Care Hospital (City Care Hospital, Kanpur)"],
      ["Address:", "123 MG Road, Near Civil Lines, Kanpur, Uttar Pradesh (123 MG Road, Kanpur)"],
      ["Reception & Helpline:", "0512-2345678, +91-9876543210"],
      ["Emergency & Ambulance:", "24 Hours Open (Emergency Ward & Ambulance Helpline: 112 / 0512-2345679)"],
      ["OPD Timings:", "Monday to Saturday, 9:00 AM to 7:00 PM (Subah 9:00 baje se Shaam 7:00 baje tak)"],
      ["Sunday Schedule:", "OPD Closed on Sundays (Emergency and ICU remain open 24x7)."],
      ["OPD Consultation Fee:", "Rs. 500 per visit (Paramarsh Shulk: 500 Rupaye)"],
      ["Hospital Facilities:", "OPD Clinics, Pathology Lab (Blood/Urine tests), Digital X-Ray, ECG, Pharmacy/Medical Store, 24x7 Emergency"],
    ];

    doc.fontSize(9).font("Helvetica");
    hospitalDetails.forEach(([label, value]) => {
      doc
        .font("Helvetica-Bold")
        .fillColor("#0f172a")
        .text(label, { continued: true, width: 160 })
        .font("Helvetica")
        .fillColor("#334155")
        .text(" " + value);
      doc.moveDown(0.2);
    });

    doc.moveDown(0.8);

    // Section 2: Three Daily Appointment Shifts Policy
    doc
      .fillColor("#1a365d")
      .fontSize(13)
      .font("Helvetica-Bold")
      .text("2. APPOINTMENT TIME SLOTS POLICY (THREE SHIFTS ONLY)");

    doc
      .strokeColor("#cbd5e1")
      .lineWidth(1)
      .moveTo(40, doc.y + 2)
      .lineTo(555, doc.y + 2)
      .stroke();

    doc.moveDown(0.6);

    doc
      .fontSize(9.5)
      .font("Helvetica")
      .fillColor("#334155")
      .text(
        "For all OPD doctors at City Care Hospital, appointments are scheduled in ONLY THREE standardized daily shifts:"
      );

    doc.moveDown(0.3);

    const shifts = [
      ["Shift 1: Subah (Morning Shift)", "10:00 AM (Subah 10:00 Baje)"],
      ["Shift 2: Dopahar / Noon (Afternoon Shift)", "2:00 PM (Dopahar 2:00 Baje)"],
      ["Shift 3: Shaam (Evening Shift)", "5:30 PM (Shaam 5:30 Baje)"],
    ];

    shifts.forEach(([shiftName, timeSlot]) => {
      doc
        .font("Helvetica-Bold")
        .fillColor("#0f766e")
        .text("   * " + shiftName + ": ", { continued: true })
        .fillColor("#0f172a")
        .text(timeSlot);
      doc.moveDown(0.25);
    });

    doc.moveDown(0.3);
    doc
      .font("Helvetica-Oblique")
      .fillColor("#475569")
      .fontSize(8.5)
      .text(
        "Voice Receptionist Instructions: When callers ask what time it is, state the live current time (IST). When callers inquire about appointment times, offer only these three slots: Subah 10:00 AM, Dopahar 2:00 PM, and Shaam 5:30 PM."
      );

    doc.moveDown(0.8);

    // Section 3: Complete Doctors Directory
    doc
      .fillColor("#1a365d")
      .fontSize(13)
      .font("Helvetica-Bold")
      .text("3. DOCTORS DIRECTORY, SPECIALTIES & SCHEDULE");

    doc
      .strokeColor("#cbd5e1")
      .lineWidth(1)
      .moveTo(40, doc.y + 2)
      .lineTo(555, doc.y + 2)
      .stroke();

    doc.moveDown(0.6);

    const doctors = [
      {
        name: "Dr. Ananya Sharma",
        hindiTitle: "Doctor Ananya Sharma (General Physician / Samanya Chikitsak)",
        specialty: "General Physician / Internal Medicine",
        qualifications: "MBBS, MD (General Medicine)",
        room: "Cabin 101, First Floor",
        days: "Monday to Saturday (Somwar se Shanivar)",
        shifts: "Subah 10:00 AM, Dopahar 2:00 PM, Shaam 5:30 PM",
        fee: "Rs. 500",
        symptoms:
          "Fever (Bukhar), Cold & Cough (Jukam, Khansi), Body weakness (Kamjori), Headache (Sirdard), Stomach pain & Vomiting (Pet dard, Ulti, Dast), Viral infections, BP & Sugar checkup.",
      },
      {
        name: "Dr. Rohit Verma",
        hindiTitle: "Doctor Rohit Verma (Cardiologist / Hriday Rog Visheshagya)",
        specialty: "Cardiologist (Heart Specialist)",
        qualifications: "MBBS, MD, DM (Cardiology)",
        room: "Cabin 104, First Floor",
        days: "Monday, Wednesday, Friday (Somwar, Budhwar, Shukrawar)",
        shifts: "Subah 10:00 AM, Dopahar 2:00 PM, Shaam 5:30 PM",
        fee: "Rs. 500",
        symptoms:
          "Chest pain (Seene me dard ya bhari-pan), High Blood Pressure (High BP), Palpitations & Restlessness (Ghabrahat, Dhadkan badhna), Shortness of breath (Saans phoolna), Heart health checkup.",
      },
      {
        name: "Dr. Priya Nair",
        hindiTitle: "Doctor Priya Nair (Pediatrician / Shishu evum Baal Rog Visheshagya)",
        specialty: "Pediatrician (Child Specialist)",
        qualifications: "MBBS, MD (Pediatrics), DCH",
        room: "Cabin 108, Ground Floor (Children Ward)",
        days: "Tuesday, Thursday, Saturday (Mangalwar, Guruwar, Shanivar)",
        shifts: "Subah 10:00 AM, Dopahar 2:00 PM, Shaam 5:30 PM",
        fee: "Rs. 500",
        symptoms:
          "Newborn & Child illnesses (Bachhon ke rog), Child fever (Bachhon ka bukhar), Child cough & cold (Shishu jukam), Vaccination/Tika-karan, Child growth & nutrition, Child stomach issues.",
      },
      {
        name: "Dr. Sanjay Gupta",
        hindiTitle: "Doctor Sanjay Gupta (Orthopedic / Haddi, Jod evum Nas Rog Visheshagya)",
        specialty: "Orthopedic Surgeon (Bone & Joint Specialist)",
        qualifications: "MBBS, MS (Orthopedics)",
        room: "Cabin 112, Ground Floor",
        days: "Monday, Tuesday, Thursday, Saturday (Somwar, Mangalwar, Guruwar, Shanivar)",
        shifts: "Subah 10:00 AM, Dopahar 2:00 PM, Shaam 5:30 PM",
        fee: "Rs. 500",
        symptoms:
          "Bone & Joint pain (Haddiyon aur jodon ka dard), Knee pain (Ghutne ka dard), Backache (Kamar dard), Arthritis (Gathiya), Cervical, Sciatica, Sprains (Moch), Fractures.",
      },
      {
        name: "Dr. Kavita Joshi",
        hindiTitle: "Doctor Kavita Joshi (Gynecologist / Stri evum Prasuti Rog Visheshagya)",
        specialty: "Gynecologist & Obstetrician (Women Health & Pregnancy)",
        qualifications: "MBBS, MS (Obstetrics & Gynecology)",
        room: "Cabin 106, First Floor",
        days: "Monday to Saturday (Somwar se Shanivar)",
        shifts: "Subah 10:00 AM, Dopahar 2:00 PM, Shaam 5:30 PM",
        fee: "Rs. 500",
        symptoms:
          "Women's health (Mahila swasthya), Pregnancy care (Garbhavastha paramarsh), Irregular Periods & PCOS/PCOD (Masik dharm samasya), Pelvic pain, Antenatal care.",
      },
      {
        name: "Dr. Rajesh Malhotra",
        hindiTitle: "Doctor Rajesh Malhotra (ENT / Kaan, Naak aur Gala Visheshagya)",
        specialty: "ENT Specialist (Ear, Nose & Throat)",
        qualifications: "MBBS, MS (ENT)",
        room: "Cabin 103, Ground Floor",
        days: "Monday, Wednesday, Saturday (Somwar, Budhwar, Shanivar)",
        shifts: "Subah 10:00 AM, Dopahar 2:00 PM, Shaam 5:30 PM",
        fee: "Rs. 500",
        symptoms:
          "Ear pain or discharge (Kaan dard ya behna), Hearing issues, Sinus & blocked nose (Sinus, band naak), Sore throat & Tonsils (Gale me dard, Tonsils), Snoring (Kharrate).",
      },
    ];

    doctors.forEach((docInfo, idx) => {
      if (doc.y > 670) {
        doc.addPage();
      }

      doc
        .fontSize(10)
        .font("Helvetica-Bold")
        .fillColor("#1e293b")
        .text(`${idx + 1}. ${docInfo.name} - ${docInfo.specialty}`);

      doc
        .fontSize(8.5)
        .font("Helvetica-Bold")
        .fillColor("#0f766e")
        .text("   Qualifications: ", { continued: true })
        .font("Helvetica")
        .fillColor("#334155")
        .text(docInfo.qualifications, { continued: true })
        .font("Helvetica-Bold")
        .fillColor("#0f766e")
        .text(" | Cabin: ", { continued: true })
        .font("Helvetica")
        .fillColor("#334155")
        .text(docInfo.room);

      doc
        .fontSize(8.5)
        .font("Helvetica-Bold")
        .fillColor("#0f766e")
        .text("   Available Days: ", { continued: true })
        .font("Helvetica")
        .fillColor("#334155")
        .text(docInfo.days, { continued: true })
        .font("Helvetica-Bold")
        .fillColor("#0f766e")
        .text(" | Shifts: ", { continued: true })
        .font("Helvetica-Bold")
        .fillColor("#b45309")
        .text(docInfo.shifts);

      doc
        .fontSize(8.5)
        .font("Helvetica-Bold")
        .fillColor("#0f766e")
        .text("   Symptoms Treated: ", { continued: true })
        .font("Helvetica")
        .fillColor("#334155")
        .text(docInfo.symptoms);

      doc.moveDown(0.45);
    });

    if (doc.y > 640) {
      doc.addPage();
    }

    // Section 4: Strict Knowledge Boundary & Policy
    doc.moveDown(0.5);
    doc
      .fillColor("#b91c1c")
      .fontSize(12)
      .font("Helvetica-Bold")
      .text("4. STRICT KNOWLEDGE BOUNDARY & UNLISTED INQUIRIES RULE");

    doc
      .strokeColor("#fca5a5")
      .lineWidth(1)
      .moveTo(40, doc.y + 2)
      .lineTo(555, doc.y + 2)
      .stroke();

    doc.moveDown(0.5);

    doc
      .fontSize(9)
      .font("Helvetica")
      .fillColor("#334155")
      .text(
        "Single Source of Truth Rule: The AI Receptionist must strictly base answers on this official directory. If a patient or caller asks any question that is NOT documented in this PDF (for example: unlisted doctors, medical treatments outside these specialties, specific medication dosages/prescriptions, surgery quotes, non-hospital topics, or outside medical advice), the receptionist must NOT guess or make up answers."
      );

    doc.moveDown(0.4);

    doc
      .font("Helvetica-Bold")
      .fillColor("#b91c1c")
      .text(
        'Required Fallback Response for Unlisted Queries: "Maaf kijiye ji, is baare mein hamare hospital record mein jaankari uplabdh nahi hai. Adhik jaankari ke liye aap hamare helpdesk number 0512-2345678 par sampark kar sakte hain, ya yadi aap doctor se paramarsh chahte hain to main appointment book kar sakti hoon."'
      );

    doc.moveDown(0.4);

    doc
      .fontSize(8.5)
      .font("Helvetica")
      .fillColor("#64748b")
      .text(
        "Emergency Protocol: In life-threatening emergencies, advise the caller to immediately come to the 24x7 Emergency Room at 123 MG Road, Kanpur, or call 112 directly."
      );

    // Section 5: Common Patient Questions & Verified Receptionist Answers (FAQ Memory)
    if (doc.y > 550) {
      doc.addPage();
    } else {
      doc.moveDown(0.8);
    }

    doc
      .fillColor("#1a365d")
      .fontSize(13)
      .font("Helvetica-Bold")
      .text("5. FREQUENTLY ASKED PATIENT QUESTIONS & OFFICIAL ANSWERS (FAQ MEMORY)");

    doc
      .strokeColor("#cbd5e1")
      .lineWidth(1)
      .moveTo(40, doc.y + 2)
      .lineTo(555, doc.y + 2)
      .stroke();

    doc.moveDown(0.5);

    const faqs = [
      [
        "Q1: Doctor consultation fees kitni hai? (Fees / Charges)",
        "A: Doctor consultation fee is flat Rs. 500 per visit, payable at the reception counter.",
      ],
      [
        "Q2: Hospital kahan par hai aur kaise pahunchein? (Address / Location)",
        "A: Hospital is located at 123 MG Road, near Civil Lines, Kanpur, Uttar Pradesh.",
      ],
      [
        "Q3: OPD ka samay kya hai aur kya Sunday ko doctor milte hain? (Timings / Sunday)",
        "A: OPD runs Monday to Saturday, 9:00 AM to 7:00 PM. Sunday OPD is closed, but 24x7 Emergency is always open.",
      ],
      [
        "Q4: Doctors ke milne ke kaun se 3 samay uplabdh hain? (3 Shifts Policy)",
        "A: All consultations have only 3 daily shifts: Subah 10:00 AM, Dopahar 2:00 PM, and Shaam 5:30 PM.",
      ],
      [
        "Q5: Kya blood test, X-Ray ya ECG ki suvidha hai? (Diagnostic Tests)",
        "A: Yes, in-house Pathology Lab (blood/urine tests), Digital X-Ray, and ECG are open daily during OPD hours.",
      ],
      [
        "Q6: Kya dawaiyan hospital mein mil jayengi? (Pharmacy / Medical Store)",
        "A: Yes, 24x7 in-house Pharmacy/Medical Store is open on the ground floor with all prescribed medicines.",
      ],
      [
        "Q7: Kya bina appointment ke direct aa sakte hain? (Walk-in vs Appointment)",
        "A: Yes, direct walk-in is allowed, but booking an appointment avoids waiting in line and guarantees your slot.",
      ],
      [
        "Q8: Emergency ho toh kya karein? (Night / Critical Emergency)",
        "A: 24x7 Emergency & Trauma Center is open at 123 MG Road, Kanpur. Ambulance & Helpline: 112 / 0512-2345679.",
      ],
      [
        "Q9: Appointment ka samay badalna ho toh? (Rescheduling / Changes)",
        "A: You can call this reception number anytime to reschedule to 10:00 AM, 2:00 PM, or 5:30 PM.",
      ],
      [
        "Q10: Bukhar, sirdard ya kamjori ke liye kaun se doctor hain?",
        "A: Dr. Ananya Sharma (General Physician, Cabin 101, Monday to Saturday).",
      ],
      [
        "Q11: Seene me dard, high BP ya dil ki bimari ke liye kaun se doctor hain?",
        "A: Dr. Rohit Verma (Cardiologist, Cabin 104, Mon, Wed, Fri).",
      ],
      [
        "Q12: Bachhon ke bukhar ya vaccination (tike) ke liye kaun se doctor hain?",
        "A: Dr. Priya Nair (Pediatrician / Child Specialist, Cabin 108, Tue, Thu, Sat).",
      ],
      [
        "Q13: Ghutne, kamar ya haddi-jod ke dard ke liye kaun se doctor hain?",
        "A: Dr. Sanjay Gupta (Orthopedic Surgeon, Cabin 112, Mon, Tue, Thu, Sat).",
      ],
      [
        "Q14: Mahila swasthya, pregnancy ya periods problem ke liye kaun se doctor hain?",
        "A: Dr. Kavita Joshi (Gynecologist, Cabin 106, Monday to Saturday).",
      ],
      [
        "Q15: Kaan, naak, gale ya tonsils ke liye kaun se doctor hain?",
        "A: Dr. Rajesh Malhotra (ENT Specialist, Cabin 103, Mon, Wed, Sat).",
      ],
    ];

    faqs.forEach(([q, a]) => {
      if (doc.y > 690) {
        doc.addPage();
      }
      doc
        .fontSize(8.5)
        .font("Helvetica-Bold")
        .fillColor("#0f766e")
        .text(q);
      doc
        .fontSize(8)
        .font("Helvetica")
        .fillColor("#334155")
        .text("   " + a);
      doc.moveDown(0.25);
    });

    doc.end();

    writeStream.on("finish", () => {
      console.log(`[PDF Generator] ✅ Successfully generated hospital directory at: ${targetPath}`);
      resolve(targetPath);
    });

    writeStream.on("error", (err) => {
      console.error("[PDF Generator] ❌ Error writing PDF:", err);
      reject(err);
    });
  });
}

if (require.main === module) {
  generateHospitalPdf().then((p) => console.log("Done:", p));
}

module.exports = { generateHospitalPdf };
