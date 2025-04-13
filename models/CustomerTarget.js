const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const CustomerTargetSchema = new Schema({
  // Customer code (maps to CardCode in SAP)
  cardCode: {
    type: String,
    required: [true, "Customer code is required"],
    trim: true,
    index: true,
  },

  // Customer name for reference
  cardName: {
    type: String,
    required: [true, "Customer name is required"],
    trim: true,
  },

  // Target amount to be achieved
  targetAmount: {
    type: Number,
    required: [true, "Target amount is required"],
    default: 0,
  },

  // Actual amount achieved so far
  achievedAmount: {
    type: Number,
    default: 0,
  },

  // Achievement rate (percentage)
  achievementRate: {
    type: Number,
    default: 0,
  },

  // Target deadline
  deadline: {
    type: Date,
    required: [true, "Target deadline is required"],
  },

  // Start date for this target
  startDate: {
    type: Date,
    required: [true, "Start date is required"],
    default: Date.now,
  },

  // Sales agent assigned to this customer
  salesAgent: {
    type: Schema.Types.ObjectId,
    ref: "User",
    required: [true, "Sales agent is required"],
  },

  // Created by (admin or sales manager)
  createdBy: {
    type: Schema.Types.ObjectId,
    ref: "User",
    required: [true, "Creator is required"],
  },

  // Creation date
  createdAt: {
    type: Date,
    default: Date.now,
  },

  // Last update date
  updatedAt: {
    type: Date,
    default: Date.now,
  },

  // Order history that contributes to this target
  orders: [
    {
      orderId: {
        type: Schema.Types.ObjectId,
        ref: "SalesOrder",
      },
      docEntry: {
        type: Number,
      },
      docTotal: {
        type: Number,
      },
      docDate: {
        type: Date,
      },
    },
  ],

  // Status of the target
  status: {
    type: String,
    enum: ["active", "completed", "expired"],
    default: "active",
  },

  // Notes or comments about this target
  notes: {
    type: String,
    trim: true,
  },
});

// Add methods or virtuals if needed
CustomerTargetSchema.virtual("remainingAmount").get(function () {
  return Math.max(0, this.targetAmount - this.achievedAmount);
});

CustomerTargetSchema.virtual("daysRemaining").get(function () {
  const today = new Date();
  const deadline = new Date(this.deadline);
  const diffTime = deadline - today;
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
});

// Update timestamp before save
CustomerTargetSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model("CustomerTarget", CustomerTargetSchema);
