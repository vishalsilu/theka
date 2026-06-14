import mongoose from "mongoose";
import { v4 as uuidv4 } from 'uuid';

const SupportReplySchema = new mongoose.Schema(
  {
    from: { type: String, trim: true, default: 'admin' },
    senderName: { type: String, trim: true, default: '' },
    senderRole: { type: String, trim: true, default: '' },
    message: { type: String, trim: true, required: true },
    sentAt: { type: Date, default: Date.now }
  },
  { _id: false }
);

const SupportTicketSchema = new mongoose.Schema(
  {
    ticketId: { type: String, required: true, unique: true, default: () => uuidv4() },
    userId: { type: String, trim: true, default: 'Guest' },
    name: { type: String, trim: true, required: true },
    email: { type: String, trim: true, required: true },
    subject: { type: String, trim: true, required: true },
    message: { type: String, trim: true, required: true },
    source: { type: String, trim: true, default: 'contact_form' },
    status: { type: String, trim: true, enum: ['new', 'open', 'pending', 'resolved', 'closed'], default: 'new' },
    assignedTo: { type: String, trim: true, default: '' },
    mailSent: { type: Boolean, default: false },
    replies: { type: [SupportReplySchema], default: [] }
  },
  {
    timestamps: true,
    minimize: false,
  }
);

const SupportTicket = mongoose.model('SupportTicket', SupportTicketSchema);
export default SupportTicket;
