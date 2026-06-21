const generateProfessionalInvoiceHTML = (orderData, siteData) => {
  // Normalize payloads
  const orderObj = (orderData && orderData.order) || (orderData && orderData.data && orderData.data.order) || orderData || {};
  
  // Extract data safely
  const items = Array.isArray(orderObj.items) ? orderObj.items : [];
  const billing = orderObj.billingAddress || orderObj.customer?.billing || orderObj.shippingAddress || {};
  const shippingAddr = orderObj.shippingAddress || orderObj.customer?.shipping || {};
  const customer = orderObj.customer || {};
  
  // Calculations
  const subtotal = Number(orderObj.subtotal) || items.reduce((s, it) => s + ((Number(it.price) || 0) * (Number(it.quantity) || 1)), 0);
  const code = orderObj.coupon?.code || '';
  const discount = Number(orderObj.discount) || orderObj.coupon?.discountAmount || 0;
  const shipping = code && code === "FREESHIP" ? "FREE" : Number(orderObj.shipping) || 0;
  const tax = Number(orderObj.tax) || 0;
  const total = Number(orderObj.total) || (subtotal - discount + (shipping === "FREE" ? 0 : shipping) + tax);

  // 🔥 REAL SITE DATA MAPPING 🔥
  const companyName = siteData?.websiteName || 'Our Store';
  const companyAddr = siteData?.contact?.address || '';
  const companyEmail = siteData?.contact?.email || '';
  const companyPhone = siteData?.contact?.phone || '';
  const footerText = siteData?.footerText || 'Thank you for shopping with us!';
  
  const logoImg = siteData?.logoUrl 
    ? `<img src="${siteData.logoUrl}" class="logo" alt="${companyName} Logo" onerror="this.style.display='none'"/>` 
    : `<h2 style="margin: 0; font-size: 28px; font-weight: 800; letter-spacing: -0.5px;">${companyName}</h2>`;
  
  const created = new Date(orderObj.createdAt || orderObj.created_at || Date.now()).toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' });
  const invoiceNo = orderObj.orderId || orderObj.id || 'N/A';
  
  // Transaction Details
  const paymentStatus = (orderObj.paymentStatus || orderObj.status || 'Pending').toUpperCase();
  const paymentMethod = (orderObj.paymentMethod || 'COD').toUpperCase();
  const transactionId = orderObj.paymentDetails?.razorpayPaymentId || orderObj.transactionId || orderObj.paymentId || 'N/A';

  // Generate Items HTML
  const itemsHtml = items.map((i, index) => {
    const qty = Number(i.quantity) || 1;
    const unit = Number(i.price) || 0;
    const line = unit * qty;
    return `
      <tr>
        <td class="text-center">${index + 1}</td>
        <td>
          <div class="item-name">${i.name || i.title || 'Product'}</div>
          ${i.variant ? `<div class="item-meta">Variant: ${i.variant}</div>` : ''}
          ${i.size ? `<div class="item-meta">Size: ${i.size}</div>` : ''}
        </td>
        <td class="text-right">₹${unit.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
        <td class="text-center">${qty}</td>
        <td class="text-right font-semibold">₹${line.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
      </tr>
    `;
  }).join('\n');

  return `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <title>Invoice #${invoiceNo}</title>
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
      
      body {
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        color: #334155;
        background: #ffffff;
        margin: 0;
        padding: 0;
        line-height: 1.5;
      }
      .invoice-container {
        width: 800px;
        margin: 0 auto;
        padding: 40px;
        background: #fff;
        box-sizing: border-box;
      }
      /* Header section */
      .header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        border-bottom: 2px solid #f1f5f9;
        padding-bottom: 24px;
        margin-bottom: 32px;
      }
      .logo {
        max-height: 50px;
        max-width: 180px;
        object-fit: contain;
      }
      .company-details {
        margin-top: 12px;
        font-size: 12px;
        color: #64748b;
        white-space: pre-line;
        line-height: 1.6;
      }
      .invoice-title {
        text-align: right;
      }
      .invoice-title h1 {
        margin: 0;
        font-size: 36px;
        font-weight: 800;
        color: #0f172a;
        letter-spacing: 1px;
      }
      .invoice-meta-top {
        margin-top: 8px;
        font-size: 13px;
        color: #64748b;
      }
      .invoice-meta-top span {
        font-weight: 600;
        color: #0f172a;
      }

      /* 3-Column Info Grid */
      .grid-addresses {
        display: flex;
        justify-content: space-between;
        margin-bottom: 40px;
        gap: 20px;
      }
      .address-block {
        flex: 1;
        background: #f8fafc;
        padding: 20px;
        border-radius: 8px;
        border: 1px solid #f1f5f9;
      }
      .address-title {
        font-size: 11px;
        text-transform: uppercase;
        font-weight: 700;
        color: #94a3b8;
        letter-spacing: 1px;
        margin-bottom: 12px;
        border-bottom: 1px solid #e2e8f0;
        padding-bottom: 6px;
      }
      .address-content {
        font-size: 13px;
        color: #334155;
        line-height: 1.6;
      }
      .address-name {
        font-weight: 700;
        font-size: 14px;
        color: #0f172a;
        margin-bottom: 4px;
      }
      .contact-row {
        margin-top: 8px;
        font-size: 12px;
        color: #475569;
      }

      /* Table */
      table {
        width: 100%;
        border-collapse: collapse;
        margin-bottom: 32px;
      }
      th {
        background: #f1f5f9;
        padding: 12px;
        font-size: 12px;
        font-weight: 600;
        color: #475569;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        border-bottom: 2px solid #e2e8f0;
        text-align: left;
      }
      td {
        padding: 16px 12px;
        font-size: 13px;
        border-bottom: 1px solid #e2e8f0;
        vertical-align: top;
      }
      .item-name {
        font-weight: 600;
        color: #0f172a;
      }
      .item-meta {
        font-size: 11px;
        color: #64748b;
        margin-top: 4px;
      }
      .text-center { text-align: center; }
      .text-right { text-align: right; }
      .font-semibold { font-weight: 600; }

      /* Totals Section */
      .totals-wrapper {
        display: flex;
        justify-content: flex-end;
      }
      .totals-table {
        width: 320px;
      }
      .totals-row {
        display: flex;
        justify-content: space-between;
        padding: 8px 0;
        font-size: 13px;
        color: #475569;
      }
      .totals-row.grand-total {
        font-size: 18px;
        font-weight: 700;
        color: #0f172a;
        border-top: 2px solid #e2e8f0;
        padding-top: 16px;
        margin-top: 8px;
      }

      /* Rich Footer */
      .footer-wrapper {
        margin-top: 60px;
        padding-top: 24px;
        border-top: 2px solid #f1f5f9;
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
      }
      .terms-box {
        max-width: 60%;
      }
      .terms-box h4 {
        margin: 0 0 8px 0;
        font-size: 12px;
        text-transform: uppercase;
        color: #94a3b8;
        letter-spacing: 0.5px;
      }
      .terms-box p, .terms-box ul {
        margin: 0;
        font-size: 11px;
        color: #64748b;
        padding-left: 14px;
      }
      .signature-box {
        text-align: center;
        width: 200px;
      }
      .signature-line {
        border-bottom: 1px solid #cbd5e1;
        height: 40px;
        margin-bottom: 8px;
      }
      .signature-text {
        font-size: 11px;
        color: #64748b;
        font-weight: 600;
      }
      .company-meta {
        margin-top: 30px;
        text-align: center;
        font-size: 11px;
        color: #94a3b8;
      }
    </style>
  </head>
  <body>
    <div class="invoice-container">
      
      <div class="header">
        <div>
          ${logoImg}
          <div class="company-details">
            ${companyAddr ? `${companyAddr}<br>` : ''}
            ${companyEmail ? `Email: ${companyEmail}<br>` : ''}
            ${companyPhone ? `Phone: ${companyPhone}` : ''}
          </div>
        </div>
        <div class="invoice-title">
          <h1>INVOICE</h1>
          <div class="invoice-meta-top">
            <div>Invoice No: <span>#${invoiceNo}</span></div>
            <div>Date: <span>${created}</span></div>
          </div>
        </div>
      </div>

      <div class="grid-addresses">
        
        <div class="address-block">
          <div class="address-title">Billed To</div>
          <div class="address-content">
            <div class="address-name">${billing.firstName || customer.firstName || 'Customer'} ${billing.lastName || customer.lastName || ''}</div>
            <div>${billing.street || billing.address || 'Address unavailable'}</div>
            <div>${billing.city || ''} ${billing.state || ''} ${billing.zip || ''}</div>
            
            <div class="contact-row">
              <strong style="color: #0f172a;">Email:</strong> ${customer.email || billing.email || orderObj.email || '—'}<br>
              <strong style="color: #0f172a;">Phone:</strong> ${customer.phone || billing.mobile || orderObj.phone || '—'}
            </div>
          </div>
        </div>

        <div class="address-block">
          <div class="address-title">Shipped To</div>
          <div class="address-content">
            <div class="address-name">${shippingAddr.firstName || 'Recipient'} ${shippingAddr.lastName || ''}</div>
            <div>${shippingAddr.street || shippingAddr.address || 'Address unavailable'}</div>
            <div>${shippingAddr.city || ''} ${shippingAddr.state || ''} ${shippingAddr.zip || ''}</div>
            
            <div class="contact-row">
              <strong style="color: #0f172a;">Phone:</strong> ${shippingAddr.mobile || '—'}
            </div>
          </div>
        </div>

        <div class="address-block">
          <div class="address-title">Transaction Details</div>
          <div class="address-content" style="font-size: 12px;">
            <div style="margin-bottom: 6px;">
              <span style="color: #64748b;">Method:</span><br>
              <strong style="color: #0f172a;">${paymentMethod}</strong>
            </div>
            <div style="margin-bottom: 6px;">
              <span style="color: #64748b;">Status:</span><br>
              <strong style="${paymentStatus === 'PAID' || paymentStatus === 'COMPLETED' ? 'color: #10b981;' : 'color: #f59e0b;'}">${paymentStatus}</strong>
            </div>
            ${transactionId !== 'N/A' ? `
            <div>
              <span style="color: #64748b;">Transaction ID:</span><br>
              <strong style="color: #0f172a; word-break: break-all;">${transactionId}</strong>
            </div>` : ''}
          </div>
        </div>

      </div>

      <table>
        <thead>
          <tr>
            <th class="text-center" style="width: 5%">#</th>
            <th style="width: 50%">Item Description</th>
            <th class="text-right" style="width: 15%">Unit Price</th>
            <th class="text-center" style="width: 10%">Qty</th>
            <th class="text-right" style="width: 20%">Total</th>
          </tr>
        </thead>
        <tbody>
          ${itemsHtml || `<tr><td colspan="5" class="text-center" style="color: #94a3b8;">No items found</td></tr>`}
        </tbody>
      </table>

      <div class="totals-wrapper">
        <div class="totals-table">
          <div class="totals-row">
            <span>Subtotal</span>
            <span class="font-semibold">₹${subtotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
          </div>
          ${discount > 0 ? `
          <div class="totals-row" style="color: #10b981;">
            <span>Discount ${code ? `(${code})` : ''}</span>
            <span class="font-semibold">-₹${discount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
          </div>` : ''}
          <div class="totals-row">
            <span>Shipping</span>
            <span class="font-semibold">${shipping === "FREE" ? 'FREE' : `₹${shipping.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`}</span>
          </div>
          <div class="totals-row grand-total">
            <span>Total Amount</span>
            <span>₹${total.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
          </div>
        </div>
      </div>

      <div class="footer-wrapper">
        <div class="terms-box">
          <h4>Terms & Conditions</h4>
          <ul>
            <li>All items are inclusive of applicable taxes.</li>
            <li>Returns and exchanges are accepted within 7 days of delivery as per company policy.</li>
            <li>This is a computer-generated invoice and does not require a physical signature.</li>
          </ul>
        </div>
        
        <div class="signature-box">
          <div class="signature-line"></div>
          <div class="signature-text">Authorized Signatory</div>
          <div style="font-size: 10px; color: #94a3b8; margin-top: 4px;">For ${companyName}</div>
        </div>
      </div>

      <div class="company-meta">
        <strong>${companyName}</strong><br>
        ${footerText}
      </div>

    </div>
  </body>
  </html>
  `;
};

export default generateProfessionalInvoiceHTML;