/**
 * SINGLE SOURCE OF TRUTH for City Heights Realty (Real Estate Agency).
 *
 * Configures properties, projects, site visit shifts, pricing, amenities,
 * and conversational parameters for the AI Property Calling Agent.
 */

module.exports = {
  agencyName: "डेफिक डिजिटल — रियल एस्टेट डिवीज़न",
  agencyNameEn: "Deific Digital — Real Estate Division",
  officePhone: "0512-2580123",
  helpdeskMobile: "+91-9876543210",
  officeAddress: "डेफिक डिजिटल कॉर्पोरेट टॉवर, 123 एमजी रोड, सिविल लाइंस, कानपुर",
  workingDays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
  workingHoursText: "सोमवार से रविवार, सुबह नौ से शाम सात बजे तक साइट विज़िट खुली रहती है।",

  // Calling Agent Name
  assistantName: "मोनिका",
  assistantNameEn: "Monica",

  // Master System Prompt Greeting
  greeting: "नमस्ते! मैं डेफिक डिजिटल से आपकी प्रॉपर्टी असिस्टेंट मोनिका हूँ। आज आप कैसे हैं?",

  // Site visit shifts (10:00 AM, 2:00 PM, 5:30 PM)
  shifts: [
    { key: "morning", time: "10:00 AM", minutes: 10 * 60, spoken: "सुबह दस बजे" },
    { key: "noon", time: "2:00 PM", minutes: 14 * 60, spoken: "दोपहर दो बजे" },
    { key: "evening", time: "5:30 PM", minutes: 17 * 60 + 30, spoken: "शाम साढ़े पाँच बजे" },
  ],

  // Max site visits per slot
  slotCapacity: Number(process.env.SLOT_CAPACITY || 6),

  // Booking lead time cutoff (e.g. at 9:40 AM, 10:00 AM today cannot be booked)
  slotLeadMinutes: Number(process.env.SLOT_LEAD_MINUTES || 30),

  // Projects & Properties Catalog
  projects: [
    {
      name: "City Greens Residency",
      hindiName: "सिटी ग्रीन्स रेजिडेंसी",
      type: "Residential Apartments (2 & 3 BHK)",
      typeHindi: "लक्जरी फ्लैट्स (2 और 3 बीएचके)",
      location: "सिविल लाइंस, कानपुर (Civil Lines, Kanpur)",
      startingPrice: "₹45 लाख",
      configurations: [
        { unit: "2 BHK Flat", area: "1050 sq ft", price: "₹45 लाख", possession: "Ready to move" },
        { unit: "3 BHK Flat", area: "1450 sq ft", price: "₹65 लाख", possession: "Ready to move" },
      ],
      availableDays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
      amenities: "क्लब हाउस, स्विमिंग पूल, जिम, 24 घंटे बिजली-पानी बैकअप, कवर्ड पार्किंग, बच्चों का पार्क",
      aliases: ["city greens", "greens", "flat", "flats", "apartment", "apartments", "2bhk", "3bhk", "2 bhk", "3 bhk", "फ्लैट", "अपार्टमेंट", "सिटी ग्रीन्स"],
    },
    {
      name: "Royal Palm Villas",
      hindiName: "रॉयल पाम विला",
      type: "Luxury Gated Villas (3 & 4 BHK)",
      typeHindi: "प्रीमियम विला (3 और 4 बीएचके डुप्लेक्स)",
      location: "गंगा बैराज रोड, कानपुर (Ganga Barrage Road, Kanpur)",
      startingPrice: "₹95 लाख",
      configurations: [
        { unit: "3 BHK Duplex Villa", area: "1800 sq ft", price: "₹95 लाख", possession: "Ready in 6 months" },
        { unit: "4 BHK Royal Villa", area: "2500 sq ft", price: "₹1.45 करोड़", possession: "Ready in 6 months" },
      ],
      availableDays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
      amenities: "प्राइवेट गार्डन, गेटेड टाउनशिप, 40 फीट चौड़ी सड़कें, सोलर स्ट्रीट लाइट्स, क्लब हाउस",
      aliases: ["royal palm", "palm", "villa", "villas", "kothi", "bungalow", "विला", "कोठी", "बंगला", "रॉयल पाम"],
    },
    {
      name: "Green Valley Plots",
      hindiName: "ग्रीन वैली प्लॉट्स",
      type: "Residential Freehold Plots",
      typeHindi: "रेजिडेंशियल प्लॉट्स (तुरंत रजिस्ट्री)",
      location: "कल्याणपुर - जीटी रोड, कानपुर (Kalyanpur, Kanpur)",
      startingPrice: "₹25 लाख",
      configurations: [
        { unit: "100 sq yard Plot", area: "900 sq ft", price: "₹25 लाख", possession: "Immediate registry" },
        { unit: "150 sq yard Plot", area: "1350 sq ft", price: "₹37.5 लाख", possession: "Immediate registry" },
        { unit: "200 sq yard Plot", area: "1800 sq ft", price: "₹50 लाख", possession: "Immediate registry" },
      ],
      availableDays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
      amenities: "दाखिल-खारिज तुरंत, बिजली के खंभे, सीवर लाइन, 35 फीट चौड़ी सड़क, बाउंड्री वॉल",
      aliases: ["green valley", "plot", "plots", "land", "जमीन", "प्लॉट", "प्लॉट्स", "ग्रीन वैली"],
    },
    {
      name: "Apex Commercial Plaza",
      hindiName: "एपेक्स कमर्शियल प्लाजा",
      type: "Commercial Retail Shops & Offices",
      typeHindi: "दुकानें और ऑफिस स्पेस",
      location: "एमजी रोड, कानपुर (MG Road, Kanpur)",
      startingPrice: "₹35 लाख",
      configurations: [
        { unit: "Retail Shop", area: "250 sq ft", price: "₹35 लाख", possession: "Ready to fit-out" },
        { unit: "Corporate Office", area: "500 sq ft", price: "₹55 लाख", possession: "Ready to fit-out" },
      ],
      availableDays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
      amenities: "हाई-फुटफॉल मेन रोड, 7% रेंटल यील्ड, एस्केलेटर, मल्टी-लेवल कार पार्किंग, 24x7 पावर बैकअप",
      aliases: ["apex", "commercial", "shop", "shops", "office", "offices", "दुकान", "ऑफिस", "कमर्शियल", "एपेक्स"],
    },
  ],

  // Property / Project mapper alias
  get doctors() {
    return this.projects;
  },
  get address() {
    return this.officeAddress;
  },

  faq: [
    "होम लोन सुविधा: हमारे प्रोजेक्ट्स SBI, HDFC और ICICI से अप्रूव्ड हैं। 80% से 85% तक होम लोन आसानी से हो जाता है।",
    "रजिस्ट्री और RERA: हमारे सभी प्रोजेक्ट्स रेरा (RERA) रजिस्टर्ड और कानूनी रूप से पूरी तरह साफ़ (Clear Title) हैं।",
    "मुफ़्त साइट विज़िट: साइट विज़िट बिल्कुल मुफ़्त है, और हम आपके घर से फ़्री कैब पिकअप और ड्रॉप की सुविधा भी देते हैं।",
    "टोकन अमाउंट: बुकिंग के लिए मात्र ₹51,000 का टोकन अमाउंट लगता है, जो साइट पसंद आने पर दे सकते हैं।",
    "पजेशन टाइम: सिटी ग्रीन्स में रेडी-टू-मूव फ्लैट्स हैं, और रॉयल पाम विला में 6 महीने में पजेशन मिलेगा।",
    "ऑफिस का पता: डेफिक डिजिटल कॉर्पोरेट टॉवर, 123 एमजी रोड, सिविल लाइंस, कानपुर।",
  ],

  // Special Offers & Deals (Master Prompt Section 12)
  specialOffers: [
    "इस सप्ताह साइट विज़िट बुक करने पर मॉड्यूलर किचन का फ़्री सेटअप उपलब्ध है।",
    "SBI और HDFC से होम लोन पर शून्य प्रोसेसिंग फ़ीस का विशेष ऑफर चल रहा है।",
  ],

  // Monica AI Voice Agent Pricing (Master Prompt Section 17)
  agentPricing: {
    INDIA: "सेटअप चार्ज पंद्रह हज़ार रुपये, और दूसरे महीने से पैंतालीस सौ रुपये प्रति महीना।",
    UAE: "सेटअप चार्ज नौ सौ निन्यानवे दिरहम, और दूसरे महीने से तीन सौ निन्यानवे दिरहम प्रति महीना।",
  },

  // Specific query fallbacks
  handoffReply: "ज़रूर, मैं आपकी कॉल हमारे सीनियर प्रॉपर्टी मैनेजर से जोड़ रही हूँ, कृपया एक पल लाइन पर बने रहें।",
  closingReply: "बात करने के लिए धन्यवाद, आपका दिन शुभ हो!",
  unlistedQueryFallback:
    "माफ़ कीजिए, फिलहाल हमारे पास केवल कानपुर में 2/3 BHK फ्लैट्स, विला, कमर्शियल दुकानें और प्लॉट्स उपलब्ध हैं। अधिक जानकारी के लिए आप हमारे हेड ऑफिस शून्य पाँच एक दो, दो पाँच आठ शून्य एक दो तीन पर कॉल कर सकते हैं। क्या मैं किसी प्रॉपर्टी की साइट विज़िट बुक कर दूँ?",
};
