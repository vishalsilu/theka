import crypto from 'crypto';
import SupportTicket from '../models/SupportTicket.js';
import { sendEmail } from '../config/email.js';
import SiteData from '../models/SiteData.js';

const ALLOWED_TICKET_STATUSES = ['new', 'open', 'pending', 'resolved', 'closed'];

// ==========================================
// ADMIN CONTROLLERS
// ==========================================

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
      return res.status(200).json({ success: false, error: 'Support ticket not found' });
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
      return res.status(200).json({ success: false, error: 'Support ticket not found' });
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
      return res.status(200).json({ success: false, error: 'Support ticket not found' });
    }

    const replyPayload = {
      from: 'admin',
      senderName: String(req.user?.email || req.user?.id || 'Admin'),
      senderRole: String(req.user?.role || 'Admin'),
      adminEmail: req.user?.email, // Added so the React UI can display who replied
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


// ==========================================
// USER CONTROLLERS
// ==========================================

export const createSupportTicketUser = async (req, res) => {
  try {
    const { subject, message } = req.body;

    if (!subject || !message) {
      return res.status(400).json({ success: false, error: 'Subject and message are required' });
    }

    // Generate a unique, readable Ticket ID (e.g., TKT-A8F9K2)
    const ticketId = `TKT-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    
    const newTicket = new SupportTicket({
      ticketId,
      userId: req.user.id, // Assumes auth middleware sets req.user
      name: `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || 'Customer',
      email: req.user.email,
      subject: String(subject).trim(),
      message: String(message).trim(),
      status: 'new',
      replies: []
    });

    await newTicket.save();

    // Send confirmation email to the user
    const siteConfig = await SiteData.findOne({});
    const supportSender = siteConfig?.contact?.email || 'support@yourdomain.com';
    
    await sendEmail({
      to: req.user.email,
      subject: `Support Ticket Created: ${ticketId}`,
      html: `
        <div style="font-family: Arial, sans-serif; color: #1f2937;">
          <h2 style="margin-bottom: 0.5rem;">We received your request</h2>
          <p style="margin-bottom: 1rem;">Hello ${newTicket.name},</p>
          <p style="margin-bottom: 1rem;">Your support ticket (<strong>${ticketId}</strong>) has been created successfully. Our team will review your message and get back to you shortly.</p>
          <p><strong>Subject:</strong> ${newTicket.subject}</p>
          <hr style="margin: 1.5rem 0; border-color: #e2e8f0;" />
          <p style="font-size: 0.9rem; color: #475569;">You can track this ticket in your user dashboard.</p>
        </div>
      `
    }).catch(err => console.warn('Ticket confirmation email failed:', err));
    
    return res.status(201).json({ success: true, ticket: newTicket });
  } catch (error) {
    console.error('createSupportTicketUser error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

export const getSupportTicketsUser = async (req, res) => {
  try {
    // Only fetch tickets belonging to the currently authenticated user
    const tickets = await SupportTicket.find({ userId: req.user.id })
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({ success: true, tickets });
  } catch (error) {
    console.error('getSupportTicketsUser error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

export const getSupportTicketUser = async (req, res) => {
  try {
    const { ticketId } = req.params;
    
    // Ensure the ticket belongs to the user requesting it
    const ticket = await SupportTicket.findOne({ ticketId, userId: req.user.id }).lean();

    if (!ticket) {
      return res.status(200).json({ success: false, error: 'Ticket not found' });
    }

    return res.status(200).json({ success: true, ticket });
  } catch (error) {
    console.error('getSupportTicketUser error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

export const replySupportTicketUser = async (req, res) => {
  try {
    const { ticketId } = req.params;
    const { message } = req.body;

    if (!message || !String(message).trim()) {
      return res.status(400).json({ success: false, error: 'Reply message is required' });
    }

    // Find ticket and verify ownership
    const ticket = await SupportTicket.findOne({ ticketId, userId: req.user.id });
    if (!ticket) {
      return res.status(200).json({ success: false, error: 'Support ticket not found' });
    }

    // Prevent replies if the ticket is closed
    if (ticket.status === 'closed') {
        return res.status(400).json({ success: false, error: 'This ticket is closed. Please open a new ticket for further assistance.' });
    }

    const replyPayload = {
      from: 'user',
      senderName: `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || 'Customer',
      senderRole: 'User',
      message: String(message).trim(),
      sentAt: new Date()
    };

    ticket.replies.push(replyPayload);
    
    // Automatically switch status to 'open' so admins know the customer has replied
    ticket.status = 'open'; 
    await ticket.save();

    // Fetch site config to send a notification to the admin team
    const siteConfig = await SiteData.findOne({});
    const supportEmail = siteConfig?.contact?.email || 'support@yourdomain.com';
    
    // Notify the admin team that the customer replied
    await sendEmail({
      to: supportEmail, 
      subject: `[Customer Reply] Ticket: ${ticket.ticketId}`,
      html: `
        <div style="font-family: Arial, sans-serif; color: #1f2937;">
          <h2 style="margin-bottom: 0.5rem;">New Reply from ${ticket.name}</h2>
          <p style="margin-bottom: 1rem;"><strong>Ticket ID:</strong> ${ticket.ticketId}</p>
          <p style="margin-bottom: 1rem;"><strong>Subject:</strong> ${ticket.subject}</p>
          <blockquote style="background: #f8fafc; border-left: 4px solid #3b82f6; padding: 1rem; margin: 0 0 1rem 0;">${replyPayload.message}</blockquote>
          <p>Please log in to the admin panel to respond.</p>
        </div>
      `
    }).catch(err => console.warn('Admin notification email failed:', err));

    return res.status(200).json({ success: true, ticket });
  } catch (error) {
    console.error('replySupportTicketUser error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
};