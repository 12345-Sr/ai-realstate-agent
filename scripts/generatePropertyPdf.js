const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");

/**
 * Generates the official City Heights Realty Property & Projects Directory PDF.
 * Uses standard typography and bilingual English/Hindi Romanized format
 * so it is universally readable by any PDF viewer and extracts 100% clean text.
 */
function generatePropertyPdf(outputPath) {
  const targetPath =
    outputPath || path.join(__dirname, "..", "data", "realestate_properties.pdf");

  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: "A4" });
    const writeStream = fs.createWriteStream(targetPath);

    doc.pipe(writeStream);

    // Header Box
    doc.rect(40, 40, 515, 60).fill("#1e3a5f");

    doc
      .fillColor("#ffffff")
      .fontSize(20)
      .font("Helvetica-Bold")
      .text("CITY HEIGHTS REALTY (City Heights Realty, Kanpur)", 50, 52, { align: "center", width: 495 });

    doc
      .fontSize(11)
      .font("Helvetica")
      .fillColor("#e2e8f0")
      .text("Official Property Catalog & Projects Directory - Single Source of Truth", 50, 78, {
        align: "center",
        width: 495,
      });

    doc.moveDown(2);

    // Section 1: Agency Overview
    doc
      .fillColor("#1e3a5f")
      .fontSize(13)
      .font("Helvetica-Bold")
      .text("1. REAL ESTATE AGENCY INFORMATION & CONTACT DETAILS");

    doc
      .strokeColor("#cbd5e1")
      .lineWidth(1)
      .moveTo(40, doc.y + 2)
      .lineTo(555, doc.y + 2)
      .stroke();

    doc.moveDown(0.6);

    const agencyDetails = [
      ["Agency Name:", "City Heights Realty (City Heights Realty, Kanpur)"],
      ["Corporate Office:", "City Heights Corporate Tower, 123 MG Road, Civil Lines, Kanpur, UP"],
      ["Sales & Helpline:", "0512-2580123, +91-9876543210"],
      ["Office & Visit Hours:", "Monday to Sunday, 9:00 AM to 7:00 PM (7 Days Open, Subah 9 se Shaam 7 baje tak)"],
      ["RERA Certification:", "All residential & commercial projects are fully RERA Approved and Clear Title"],
      ["Site Visit Policy:", "Free Site Visits with Complimentary Doorstep Cab Pick & Drop on request"],
      ["Booking Token Amount:", "Starting at Rs. 51,000 only (refundable on site visit if unsatisfied)"],
      ["Home Loan Tie-ups:", "Pre-approved home loans up to 85% with SBI, HDFC Bank, ICICI Bank, and Bank of Baroda"],
    ];

    doc.fontSize(9).font("Helvetica");
    agencyDetails.forEach(([label, value]) => {
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

    // Section 2: Three Daily Site Visit Shifts Policy
    doc
      .fillColor("#1e3a5f")
      .fontSize(13)
      .font("Helvetica-Bold")
      .text("2. SITE VISIT APPOINTMENT SHIFTS POLICY (THREE SHIFTS ONLY)");

    doc
      .strokeColor("#cbd5e1")
      .lineWidth(1)
      .moveTo(40, doc.y + 2)
      .lineTo(555, doc.y + 2)
      .stroke();

    doc.moveDown(0.6);

    const shifts = [
      ["Shift 1 (Morning / Subah):", "10:00 AM (Subah 10:00 Baje) - Best for peaceful daylight viewing and floor plan inspection."],
      ["Shift 2 (Noon / Dopahar):", "2:00 PM (Dopahar 2:00 Baje) - Ideal for midday sunlight and neighborhood tour."],
      ["Shift 3 (Evening / Shaam):", "5:30 PM (Shaam 5:30 Baje) - Perfect for sunset lighting, club house, and township night-lighting view."],
    ];

    shifts.forEach(([label, desc]) => {
      doc
        .font("Helvetica-Bold")
        .fillColor("#0284c7")
        .text(label, { continued: true, width: 170 })
        .font("Helvetica")
        .fillColor("#1e293b")
        .text(" " + desc);
      doc.moveDown(0.2);
    });

    doc.moveDown(0.8);

    // Section 3: Projects Catalog
    doc
      .fillColor("#1e3a5f")
      .fontSize(13)
      .font("Helvetica-Bold")
      .text("3. RESIDENTIAL & COMMERCIAL PROJECTS CATALOG");

    doc
      .strokeColor("#cbd5e1")
      .lineWidth(1)
      .moveTo(40, doc.y + 2)
      .lineTo(555, doc.y + 2)
      .stroke();

    doc.moveDown(0.6);

    const projects = [
      {
        name: "Project 1: City Greens Residency (Residential Luxury Flats)",
        location: "Civil Lines, Near Metro Station, Kanpur",
        type: "2 BHK & 3 BHK High-Rise Apartments",
        price: "2 BHK (1050 sq.ft) @ Rs. 45 Lakhs | 3 BHK (1450 sq.ft) @ Rs. 65 Lakhs",
        possession: "Ready to Move (RERA Approved: UPRERA-PRJ-8821)",
        amenities: "Modern Clubhouse, Swimming Pool, Fully Equipped Gym, 24x7 Power Backup, Covered Stilt Parking, Children's Play Park, 3-tier Gated Security",
        target: "Families looking for premium ready-to-move flats in central Kanpur with easy metro and school connectivity.",
      },
      {
        name: "Project 2: Royal Palm Villas (Luxury Independent Duplex Villas)",
        location: "Ganga Barrage Road, Riverfront Township, Kanpur",
        type: "3 BHK & 4 BHK Luxury Duplex Villas",
        price: "3 BHK Villa (1800 sq.ft) @ Rs. 95 Lakhs | 4 BHK Royal Villa (2500 sq.ft) @ Rs. 1.45 Crore",
        possession: "Possession in 6 Months (Structure Ready)",
        amenities: "Private Front & Back Gardens, Gated Community, 40-feet Wide Internal Roads, Underground Electric Cables, Designer Street Lights, Private Car Porch",
        target: "Buyers seeking luxury, privacy, independent land ownership, and scenic riverside living.",
      },
      {
        name: "Project 3: Green Valley Plots (Freehold Gated Residential Plots)",
        location: "Kalyanpur - GT Road, Near University Campus, Kanpur",
        type: "Freehold Residential Plots (100, 150, 200 sq. yards)",
        price: "Starting Rs. 25 Lakhs (Rs. 25,000 per sq. yard)",
        possession: "Immediate Registry & Dakhil-Kharij (Mutation) on full payment",
        amenities: "Secured Boundary Wall Township, Electric Transformers, Water Supply Lines, Sewage System, 35-feet Wide Concrete Roads",
        target: "Investment and custom dream home construction with 100% legal title clearance and immediate registry.",
      },
      {
        name: "Project 4: Apex Commercial Plaza (High-Street Shops & Corporate Offices)",
        location: "MG Road, Main Commercial Belt, Kanpur",
        type: "Commercial Retail Shops & Corporate Office Suites",
        price: "Ground Floor Retail Shop (250 sq.ft) @ Rs. 35 Lakhs | Office Suite (500 sq.ft) @ Rs. 55 Lakhs",
        possession: "Ready for Fit-out and Business Operations",
        amenities: "Prime Main Road Frontage, High Daily Footfall, Glass Facade, Double-Height Entrance Lobby, Escalators, Multi-Level Basements Parking, 7% Rental Yield",
        target: "Investors seeking assured monthly rental income and business owners wanting prime commercial visibility.",
      },
    ];

    projects.forEach((p, idx) => {
      doc
        .font("Helvetica-Bold")
        .fontSize(10)
        .fillColor("#0f172a")
        .text(p.name);
      doc.moveDown(0.15);

      const fields = [
        ["Location:", p.location],
        ["Configuration:", p.type],
        ["Pricing:", p.price],
        ["Possession Status:", p.possession],
        ["Amenities & Features:", p.amenities],
        ["Target Buyer:", p.target],
      ];

      fields.forEach(([fLabel, fVal]) => {
        doc
          .font("Helvetica-Bold")
          .fontSize(8.5)
          .fillColor("#475569")
          .text(fLabel, { continued: true, width: 140 })
          .font("Helvetica")
          .fillColor("#1e293b")
          .text(" " + fVal);
        doc.moveDown(0.1);
      });

      doc.moveDown(0.4);
    });

    // Section 4: Financing & Home Loans
    doc
      .fillColor("#1e3a5f")
      .fontSize(13)
      .font("Helvetica-Bold")
      .text("4. HOME LOAN, REGISTRATION & BOOKING GUIDELINES");

    doc
      .strokeColor("#cbd5e1")
      .lineWidth(1)
      .moveTo(40, doc.y + 2)
      .lineTo(555, doc.y + 2)
      .stroke();

    doc.moveDown(0.6);

    const guidelines = [
      ["Bank Loan Assistance:", "Up to 80%-85% bank financing with SBI, HDFC, and ICICI at attractive home loan interest rates starting @ 8.5% p.a."],
      ["Registry & Mutation:", "All properties have 100% clean title deeds, verified search reports, and immediate registry upon payment completion."],
      ["Token Booking Process:", "Only Rs. 51,000 token amount to reserve the unit. 10% payment within 30 days upon agreement."],
      ["Site Visit Coordination:", "Free doorstep pickup & drop service is arranged by City Heights Realty for prospective buyers upon advance booking."],
    ];

    guidelines.forEach(([gLabel, gVal]) => {
      doc
        .font("Helvetica-Bold")
        .fontSize(8.5)
        .fillColor("#0f172a")
        .text(gLabel, { continued: true, width: 160 })
        .font("Helvetica")
        .fillColor("#334155")
        .text(" " + gVal);
      doc.moveDown(0.2);
    });

    doc.end();

    writeStream.on("finish", () => {
      console.log(`[generatePropertyPdf] Successfully generated PDF at: ${targetPath}`);
      resolve(targetPath);
    });

    writeStream.on("error", (err) => {
      console.error("[generatePropertyPdf] Error writing PDF:", err);
      reject(err);
    });
  });
}

if (require.main === module) {
  generatePropertyPdf();
}

module.exports = { generatePropertyPdf };
