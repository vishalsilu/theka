import Order from '../models/Order.js';
import User from '../models/Users.js';
import SiteData from '../models/SiteData.js';
import generateProfessionalInvoiceHTML from './emailTemplates.js'; 
import { sendEmail } from '../config/email.js';

export const sendMyInvoice = async (orderId) => {
  try {
    // Assuming you pass the ID in the URL: /api/orders/:orderId/invoice
    
    // 1. Fetch the Order
    const order = await Order.findOne({ orderId }).lean();
    if (!order) {
      return ({ error: "Order not found." });
    }

    // 2. Fetch the User to get their email
    const user = await User.findOne({ id: order.userId }).lean();
    if (!user || !user.email) {
      return ({ error: "User email not found. Cannot send invoice." });
    }

    // 3. Fetch Site Data for the template
    const siteData = await SiteData.findOne({}).lean() || {};
    const companyName = siteData.websiteName || "Our Store";

    // 4. Generate the HTML and send the email
    console.log(`Generating invoice email for ${companyName} - Order #${orderId}`);
    
    const emailSubject = `Order Confirmed here is your order details #${order.orderId}`;
    const emailHtml = generateProfessionalInvoiceHTML(order, siteData);

    await sendEmail({
      to: user.email,
      subject: emailSubject,
      html: emailHtml
    });

    return ({ 
      success: true, 
      message: "Invoice successfully sent to user's email." 
    });

  } catch (error) {
    console.error("Fetch invoice error:", error);
    return ({ error: error.message });
  }
};