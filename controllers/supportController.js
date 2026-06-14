import SupportTicket from '../models/SupportTicket.js';
import { sendEmail } from '../config/email.js';
import SiteData from '../models/SiteData.js';

const ALLOWED_TICKET_STATUSES = ['new', 'open', 'pending', 'resolved', 'closed'];

export const getSupportTicketsAdmin = async (req, res) => {
  try {
    const { status, q } = req.query;
    const filter = {};

    if (status && ALLOWED_TICKET_STATUSES.includes(status)) {
      filter.status = status;
    }

    if (q) {
      const regex = new RegExp(String(q).trim(), 'i');
      filter.$or = [
        { ticketId: regex },
        { name: regex },
        { email: regex },
        { subject: regex },
        { message: regex }
      ];
    }

    const tickets = await SupportTicket.find(filter).sort({ createdAt: -1 }).lean();
    return res.status(200).json({ success: true, tickets });
  } catch (error) {
    console.error('getSupportTicketsAdmin error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

export const getSupportTicketAdmin = async (req, res) => {
  try {
    const { ticketId } = req.params;
    const ticket = await SupportTicket.findOne({ ticketId }).lean();

    if (!ticket) {
      return res.status(404).json({ success: false, error: 'Support ticket not found' });
    }

    return res.status(200).json({ success: true, ticket });
  } catch (error) {
    console.error('getSupportTicketAdmin error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

export const updateSupportTicketStatusAdmin = async (req, res) => {
  try {
    const { ticketId } = req.params;
    const { status, assignedTo } = req.body;

    if (!status || !ALLOWED_TICKET_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, error: 'Invalid ticket status' });
    }

    const ticket = await SupportTicket.findOne({ ticketId });
    if (!ticket) {
      return res.status(404).json({ success: false, error: 'Support ticket not found' });
    }

    ticket.status = status;
    if (assignedTo) ticket.assignedTo = String(assignedTo).trim();
    await ticket.save();

    return res.status(200).json({ success: true, ticket });
  } catch (error) {
    console.error('updateSupportTicketStatusAdmin error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

export const replySupportTicketAdmin = async (req, res) => {
  try {
    const { ticketId } = req.params;
    const { message, status } = req.body;

    if (!message || !String(message).trim()) {
      return res.status(400).json({ success: false, error: 'Reply message is required' });
    }

    const ticket = await SupportTicket.findOne({ ticketId });
    if (!ticket) {
      return res.status(404).json({ success: false, error: 'Support ticket not found' });
    }

    const replyPayload = {
      from: 'admin',
      senderName: String(req.user?.email || req.user?.id || 'Admin'),
      senderRole: String(req.user?.role || 'Admin'),
      message: String(message).trim(),
      sentAt: new Date()
    };

    ticket.replies.push(replyPayload);
    if (status && ALLOWED_TICKET_STATUSES.includes(status)) {
      ticket.status = status;
    } else if (ticket.status === 'new') {
      ticket.status = 'open';
    }

    await ticket.save();

    const siteConfig = await SiteData.findOne({});
    const supportSender = siteConfig?.contact?.email || 'support@yourdomain.com';
    const emailResult = await sendEmail({
      to: ticket.email,
      subject: `[Support Reply] ${ticket.subject}`,
      html: `
        <div style="font-family: Arial, sans-serif; color: #1f2937;">
          <h2 style="margin-bottom: 0.5rem;">Response to your support request</h2>
          <p style="margin-bottom: 1rem;">Hello ${ticket.name},</p>
          <p style="margin-bottom: 1rem;">Our support team replied to your request:</p>
          <blockquote style="background: #f8fafc; border-left: 4px solid #0f172a; padding: 1rem; margin: 0 0 1rem 0;">${replyPayload.message}</blockquote>
          <p style="margin-bottom: 1rem;">If you need more help, simply reply to this email.</p>
          <hr style="margin: 1.5rem 0; border-color: #e2e8f0;" />
          <p style="font-size: 0.9rem; color: #475569;">Ticket ID: ${ticket.ticketId}</p>
          <p style="font-size: 0.9rem; color: #475569;">Sent from: ${supportSender}</p>
        </div>
      `
    });

    if (!emailResult?.success) {
      console.warn('Support reply email failed:', emailResult?.error);
    }

    return res.status(200).json({ success: true, ticket, emailSent: emailResult?.success ?? false });
  } catch (error) {
    console.error('replySupportTicketAdmin error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
};
