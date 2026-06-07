import mongoose from "mongoose";

const LinkSchema = new mongoose.Schema(
  {
    label: { type: String, trim: true, default: "" },
    path: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

const SocialItemSchema = new mongoose.Schema(
  {
    label: { type: String, trim: true, default: "" },
    url: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

const OfferSchema = new mongoose.Schema(
  {
    title: { type: String, trim: true, default: "" },
    description: { type: String, trim: true, default: "" },
    code: { type: String, trim: true, default: "" },
  },
  { timestamps: false }
);

const AdvertisementSchema = new mongoose.Schema(
  {
    title: { type: String, trim: true, default: "" },
    description: { type: String, trim: true, default: "" },
    imageUrl: { type: String, trim: true, default: "" },
    link: { type: String, trim: true, default: "" },
    buttonText: { type: String, trim: true, default: "" },
    location: {
      type: String,
      trim: true,
      enum: ['home', 'collection', 'product', 'cart', 'checkout', 'all'],
      default: 'all',
    },
  },
  { _id: false }
);

const HeroSchema = new mongoose.Schema(
  {
    title: { type: String, trim: true, default: "" },
    subtitle: { type: String, trim: true, default: "" },
    ctaLabel: { type: String, trim: true, default: "" },
    ctaPath: { type: String, trim: true, default: "" },
    location: {
      type: String,
      trim: true,
      enum: ['all', 'home', 'collection', 'product', 'cart', 'checkout'],
      default: 'home',
    },
    imageDesktop: { type: String, trim: true, default: "" },
    imageMobile: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

const AboutSchema = new mongoose.Schema({
  heroImage: { type: String, default: "" },
  visionHeading: { type: String, default: "The Vision" },
  visionStatement: { type: String, default: "" },
  visionDescription: { type: String, default: "" },
  coreValues: {
    heading : { type: String, default: "Core Values" },
    values: [
         {
      image: { type: String },
      alt : { type: String },
    }]
  },
  founder: {
    name: { type: String, default: "" },
    role: { type: String, default: "" },
    quote: { type: String, default: "" },
    image: { type: String, default: "" },
    establishmentTag: { type: String, default: "" }
  }
}, { _id: false });


const ContentSectionSchema = new mongoose.Schema({
  id: { type: String, trim: true },
  title: { type: String, trim: true, default: "" },
  text: { type: String, trim: true, default: "" }
}, { _id: false });

// Sub-schema for shipping metrics/delivery tiers
const ShippingMethodSchema = new mongoose.Schema({
  type: { type: String, trim: true },
  time: { type: String, trim: true }
}, { _id: false });

const ShippingSchema = new mongoose.Schema({
  defaultCost: { type: Number, default: 99 },
  freeShippingThreshold: { type: Number, default: 2000 },
  handlingTime: { type: String, trim: true, default: '' },
  methods: { type: [ShippingMethodSchema], default: [] }
}, { _id: false });

const PaymentSchema = new mongoose.Schema({
  currency: { type: String, trim: true, default: 'INR' },
  codEnabled: { type: Boolean, default: true },
  onlinePaymentEnabled: { type: Boolean, default: true },
  paymentInstructions: { type: String, trim: true, default: '' }
}, { _id: false });

const CheckoutSchema = new mongoose.Schema({
  allowGuestCheckout: { type: Boolean, default: true },
  requirePhoneOnCheckout: { type: Boolean, default: true },
  termsLink: { type: String, trim: true, default: '' },
  supportEmail: { type: String, trim: true, default: '' }
}, { _id: false });

const AnalyticsSchema = new mongoose.Schema({
  googleTagId: { type: String, trim: true, default: '' },
  facebookPixelId: { type: String, trim: true, default: '' }
}, { _id: false });

// Rich Legal Document Schema mapping to your provided JSON structure
const LegalDocumentSchema = new mongoose.Schema({
  name: { type: String, trim: true, required: true },
  link: { type: String, trim: true, required: true },
  subtitle: { type: String, trim: true, default: "" },
  highlight: { type: String, trim: true, default: "" },
  methods: { type: [ShippingMethodSchema], default: [] },
  sections: { type: [ContentSectionSchema], default: [] }
}, { _id: false });

const ContactSchema = new mongoose.Schema(
  {
    heading: { type: String, trim: true, default: "" },
    subheading: { type: String, trim: true, default: "" },
    email: { type: String, trim: true, default: "" },
    phone: { type: String, trim: true, default: "" },
    address: { type: String, trim: true, default: "" },
    workingHours: [
      {
        day: { type: String, trim: true },
        hours: { type: String, trim: true }
      }
    ],
    socials: { type: [SocialItemSchema], default: [] },
  },
  { _id: false }
);

const AuthSchema = new mongoose.Schema(
  {
    loginText: { type: String, trim: true, default: "" },
    registerText: { type: String, trim: true, default: "" },
    headingText: { type: String, trim: true, default: "" },
    subHeadingText: { type: String, trim: true, default: "" },
  },
  {_id : false}
)
const SiteDataSchema = new mongoose.Schema(
  {
    websiteName: { type: String, trim: true, default: "" },
    logoUrl: { type: String, trim: true, default: "" },
    faviconUrl: { type: String, trim: true, default: "" },
    tagline: { type: String, trim: true, default: "" },
    hero: { type: HeroSchema, default: {} },
    topOffers: { type: [OfferSchema], default: [] },
    advertisements: { type: [AdvertisementSchema], default: [] },
    about: { type: AboutSchema, default: {} },
    contact: { type: ContactSchema, default: {} },
    navigationLinks: { type: [LinkSchema], default: [] },
    legalLinks: { type: [LegalDocumentSchema], default: [] },
    footerText: { type: String, trim: true, default: "" },
    seo: { type: new mongoose.Schema({
      title: { type: String, trim: true, default: '' },
      description: { type: String, trim: true, default: '' },
      keywords: { type: String, trim: true, default: '' },
      metaImage: { type: String, trim: true, default: '' }
    }, { _id: false }), default: {} },
    payment: { type: PaymentSchema, default: {} },
    shipping: { type: ShippingSchema, default: {} },
    checkout: { type: CheckoutSchema, default: {} },
    analytics: { type: AnalyticsSchema, default: {} },
    authData : { type: AuthSchema, default: {} }
  },
  {
    timestamps: true,
    minimize: false,
  }
);

const SiteData = mongoose.model("SiteData", SiteDataSchema);

export default SiteData;
