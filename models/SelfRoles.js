const mongoose = require('mongoose');

const selfRoleOptionSchema = new mongoose.Schema({
    roleId: { type: String, required: true },
    label: { type: String, required: true, trim: true, maxlength: 100 },
    description: { type: String, default: '', trim: true, maxlength: 500 },
    emoji: { type: String, default: '' },
    bundleRoleIds: { type: [String], default: [] },
    requiredRoleIds: { type: [String], default: [] },
    deniedRoleIds: { type: [String], default: [] },
    excludesRoleIds: { type: [String], default: [] },
    durationMs: { type: Number, default: 0, min: 0 }
}, { _id: false });

const selfRoleGroupSchema = new mongoose.Schema({
    key: { type: String, required: true, trim: true, lowercase: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    mode: { type: String, enum: ['single', 'multiple'], default: 'multiple' },
    minSelections: { type: Number, default: 0, min: 0 },
    maxSelections: { type: Number, default: 0, min: 0 },
    requiredRoleIds: { type: [String], default: [] },
    deniedRoleIds: { type: [String], default: [] },
    options: { type: [selfRoleOptionSchema], default: [] }
}, { _id: false });

const selfRolePanelSchema = new mongoose.Schema({
    guildId: { type: String, required: true, index: true },
    key: { type: String, required: true, trim: true, lowercase: true, maxlength: 32 },
    title: { type: String, required: true, trim: true, maxlength: 256 },
    description: { type: String, default: '', trim: true, maxlength: 1500 },
    color: { type: Number, default: 0x5865F2 },
    status: { type: String, enum: ['draft', 'published', 'paused', 'deleted'], default: 'draft' },
    mode: { type: String, enum: ['components', 'reactions', 'both'], default: 'reactions' },
    channelId: { type: String, default: '' },
    messageId: { type: String, default: '', index: true },
    auditChannelId: { type: String, default: '' },
    requiredRoleIds: { type: [String], default: [] },
    deniedRoleIds: { type: [String], default: [] },
    groups: { type: [selfRoleGroupSchema], default: [] },
    createdBy: { type: String, default: '' },
    updatedBy: { type: String, default: '' }
}, { timestamps: true });

selfRolePanelSchema.index({ guildId: 1, key: 1 }, { unique: true });
selfRolePanelSchema.index({ guildId: 1, messageId: 1 }, { sparse: true });

const selfRoleGrantSchema = new mongoose.Schema({
    guildId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    roleId: { type: String, required: true, index: true },
    panelId: { type: mongoose.Schema.Types.ObjectId, ref: 'SelfRolePanel', required: true },
    groupKey: { type: String, required: true },
    optionRoleId: { type: String, required: true },
    removeOnExpire: { type: Boolean, default: true },
    grantedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, default: null, index: true },
    status: { type: String, enum: ['active', 'processing', 'revoked', 'expired'], default: 'active', index: true },
    lastError: { type: String, default: '' }
}, { timestamps: true });

selfRoleGrantSchema.index(
    { guildId: 1, userId: 1, roleId: 1, panelId: 1, groupKey: 1, optionRoleId: 1 },
    { unique: true }
);
selfRoleGrantSchema.index({ status: 1, expiresAt: 1 });

module.exports = {
    SelfRolePanel: mongoose.models.SelfRolePanel || mongoose.model('SelfRolePanel', selfRolePanelSchema),
    SelfRoleGrant: mongoose.models.SelfRoleGrant || mongoose.model('SelfRoleGrant', selfRoleGrantSchema)
};
