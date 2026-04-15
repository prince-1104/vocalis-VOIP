--
-- PostgreSQL database dump
--

\restrict TERu35URFTWqD8JVWeH3Xev649ZN8s1llloThbGKxWUzGhryrF23Gu0X6dDs1dL

-- Dumped from database version 16.10
-- Dumped by pg_dump version 16.10

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: agent_configs; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.agent_configs (
    id integer NOT NULL,
    user_id integer NOT NULL,
    agent_name text DEFAULT 'SalesBot'::text NOT NULL,
    voice text DEFAULT 'nova'::text NOT NULL,
    language text DEFAULT 'en-US'::text,
    phone_number text,
    twilio_account_sid text,
    twilio_auth_token text,
    greeting text,
    personality text DEFAULT 'professional'::text NOT NULL,
    max_call_duration integer DEFAULT 10 NOT NULL,
    voicemail_message text,
    business_hours_only boolean DEFAULT true NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.agent_configs OWNER TO postgres;

--
-- Name: agent_configs_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.agent_configs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.agent_configs_id_seq OWNER TO postgres;

--
-- Name: agent_configs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.agent_configs_id_seq OWNED BY public.agent_configs.id;


--
-- Name: call_logs; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.call_logs (
    id integer NOT NULL,
    user_id integer NOT NULL,
    contact_id integer,
    campaign_id integer,
    direction text DEFAULT 'outbound'::text NOT NULL,
    phone text NOT NULL,
    duration integer,
    outcome text,
    transcript text,
    recording_url text,
    ai_summary text,
    started_at timestamp without time zone DEFAULT now() NOT NULL,
    ended_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.call_logs OWNER TO postgres;

--
-- Name: call_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.call_logs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.call_logs_id_seq OWNER TO postgres;

--
-- Name: call_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.call_logs_id_seq OWNED BY public.call_logs.id;


--
-- Name: calling_scripts; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.calling_scripts (
    id integer NOT NULL,
    user_id integer NOT NULL,
    name text NOT NULL,
    description text,
    opening_line text NOT NULL,
    pitch_points jsonb DEFAULT '[]'::jsonb,
    closing_line text,
    full_script text NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.calling_scripts OWNER TO postgres;

--
-- Name: calling_scripts_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.calling_scripts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.calling_scripts_id_seq OWNER TO postgres;

--
-- Name: calling_scripts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.calling_scripts_id_seq OWNED BY public.calling_scripts.id;


--
-- Name: campaign_contacts; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.campaign_contacts (
    id integer NOT NULL,
    campaign_id integer NOT NULL,
    contact_id integer NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.campaign_contacts OWNER TO postgres;

--
-- Name: campaign_contacts_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.campaign_contacts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.campaign_contacts_id_seq OWNER TO postgres;

--
-- Name: campaign_contacts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.campaign_contacts_id_seq OWNED BY public.campaign_contacts.id;


--
-- Name: campaigns; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.campaigns (
    id integer NOT NULL,
    user_id integer NOT NULL,
    name text NOT NULL,
    description text,
    status text DEFAULT 'draft'::text NOT NULL,
    script_id integer,
    total_contacts integer DEFAULT 0 NOT NULL,
    called_count integer DEFAULT 0 NOT NULL,
    answered_count integer DEFAULT 0 NOT NULL,
    interested_count integer DEFAULT 0 NOT NULL,
    start_time text DEFAULT '09:00'::text,
    end_time text DEFAULT '17:00'::text,
    timezone text DEFAULT 'America/New_York'::text,
    max_concurrent_calls integer DEFAULT 1 NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.campaigns OWNER TO postgres;

--
-- Name: campaigns_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.campaigns_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.campaigns_id_seq OWNER TO postgres;

--
-- Name: campaigns_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.campaigns_id_seq OWNED BY public.campaigns.id;


--
-- Name: contacts; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.contacts (
    id integer NOT NULL,
    user_id integer NOT NULL,
    first_name text,
    last_name text,
    phone text NOT NULL,
    email text,
    company text,
    status text DEFAULT 'pending'::text NOT NULL,
    notes text,
    last_called_at timestamp without time zone,
    callback_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.contacts OWNER TO postgres;

--
-- Name: contacts_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.contacts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.contacts_id_seq OWNER TO postgres;

--
-- Name: contacts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.contacts_id_seq OWNED BY public.contacts.id;


--
-- Name: training_data; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.training_data (
    id integer NOT NULL,
    user_id integer NOT NULL,
    type text DEFAULT 'custom'::text NOT NULL,
    title text NOT NULL,
    content text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.training_data OWNER TO postgres;

--
-- Name: training_data_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.training_data_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.training_data_id_seq OWNER TO postgres;

--
-- Name: training_data_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.training_data_id_seq OWNED BY public.training_data.id;


--
-- Name: users; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.users (
    id integer NOT NULL,
    replit_user_id text,
    email text,
    name text,
    business_name text,
    plan text DEFAULT 'free'::text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.users OWNER TO postgres;

--
-- Name: users_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.users_id_seq OWNER TO postgres;

--
-- Name: users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;


--
-- Name: agent_configs id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.agent_configs ALTER COLUMN id SET DEFAULT nextval('public.agent_configs_id_seq'::regclass);


--
-- Name: call_logs id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.call_logs ALTER COLUMN id SET DEFAULT nextval('public.call_logs_id_seq'::regclass);


--
-- Name: calling_scripts id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.calling_scripts ALTER COLUMN id SET DEFAULT nextval('public.calling_scripts_id_seq'::regclass);


--
-- Name: campaign_contacts id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.campaign_contacts ALTER COLUMN id SET DEFAULT nextval('public.campaign_contacts_id_seq'::regclass);


--
-- Name: campaigns id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.campaigns ALTER COLUMN id SET DEFAULT nextval('public.campaigns_id_seq'::regclass);


--
-- Name: contacts id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.contacts ALTER COLUMN id SET DEFAULT nextval('public.contacts_id_seq'::regclass);


--
-- Name: training_data id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.training_data ALTER COLUMN id SET DEFAULT nextval('public.training_data_id_seq'::regclass);


--
-- Name: users id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);


--
-- Data for Name: agent_configs; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.agent_configs (id, user_id, agent_name, voice, language, phone_number, twilio_account_sid, twilio_auth_token, greeting, personality, max_call_duration, voicemail_message, business_hours_only, created_at, updated_at) FROM stdin;
1	1	G4UBot	echo	en-US	+18668544264	ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx		Hi, this is Gima calling on behalf of Generics For You. Is this a good time to speak?	professional	10	Hi, this is a message for [Name]. Please call us back at your earliest convenience. Thank you!	t	2026-03-24 10:31:40.873519	2026-03-25 05:44:16.255
\.


--
-- Data for Name: call_logs; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.call_logs (id, user_id, contact_id, campaign_id, direction, phone, duration, outcome, transcript, recording_url, ai_summary, started_at, ended_at, created_at) FROM stdin;
1	1	\N	\N	inbound	+15555551234	\N	answered	\N	\N	\N	2026-03-25 05:48:24.276	\N	2026-03-25 05:48:24.277561
2	1	\N	\N	inbound	 15555551234	\N	answered	\N	\N	\N	2026-03-25 06:08:01.194	\N	2026-03-25 06:08:01.194833
3	1	\N	\N	inbound	+15555551234	\N	answered	\N	\N	\N	2026-03-25 06:08:40.701	\N	2026-03-25 06:08:40.70148
4	1	\N	\N	inbound	+15555551234	\N	answered	\N	\N	\N	2026-03-25 06:10:23.432	\N	2026-03-25 06:10:23.434127
\.


--
-- Data for Name: calling_scripts; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.calling_scripts (id, user_id, name, description, opening_line, pitch_points, closing_line, full_script, is_default, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: campaign_contacts; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.campaign_contacts (id, campaign_id, contact_id, created_at) FROM stdin;
\.


--
-- Data for Name: campaigns; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.campaigns (id, user_id, name, description, status, script_id, total_contacts, called_count, answered_count, interested_count, start_time, end_time, timezone, max_concurrent_calls, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: contacts; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.contacts (id, user_id, first_name, last_name, phone, email, company, status, notes, last_called_at, callback_at, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: training_data; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.training_data (id, user_id, type, title, content, created_at, updated_at) FROM stdin;
1	1	product_info	test-product	{\n "company": "Acme Corp",\n "product": "SuperWidget",\n "price": "$99/month",\n "features": [\n "Feature A",\n "Feature B",\n "Feature C"\n ]\n}	2026-03-25 05:57:21.868489	2026-03-25 05:57:21.868489
2	1	product_info	test-product	{\n "company": "Acme Corp",\n "product": "SuperWidget",\n "price": "$99/month",\n "features": [\n "Feature A",\n "Feature B"\n ]\n}	2026-03-25 05:57:26.737524	2026-03-25 05:57:26.737524
3	1	product_info	Knowledge Base (KB) for G4U generics sales (part 1 of 2)	I have designed a comprehensive Knowledge Base (KB) to accompany the Alex AI Agent. This document provides the agent with the "facts" it needs to back up its sales pitch, answer technical questions, and handle objections about quality and shipping.\n\nThe following structure represents the content I have compiled for the .docx file.\n\nKnowledge Base: Generics4You.com (Internal Use Only)\n\n1. Product & Dosage Catalog\n\nThis section helps Alex identify the correct product and dosage based on the customer’s history.\n\nGeneric Name\n\nCommon Use Cases\n\nAvailable Strengths\n\nBrand Equivalent (Ref Only)\n\nSildenafil\n\nErectile Dysfunction\n\n50 mg, 100 mg\n\nViagra\n\nTadalafil\n\nED / BPH\n\n5 mg, 10 mg, 20 mg\n\nCialis\n\nSertraline\n\nAnxiety / Depression\n\n50 mg, 100 mg\n\nZoloft\n\nSumatriptan\n\nMigraine Relief\n\n50 mg, 100 mg\n\nImitrex\n\nModafinil\n\nWakefulness / ADHD\n\n100 mg, 200 mg\n\nProvigil\n\n2. Pricing & Savings Structure\n\nThe agent's primary hook is the 60% savings. Use these talking points:\n\nDirect Comparison: "Our 100 mg generic is approximately $1.50 per tablet, compared to the retail average of $4.00+."\n\nBulk Discounting: Customers ordering a 90-day supply receive an additional 10% off the already discounted rate.\n\nZero Hidden Fees: Shipping is free on orders over $50; no "consultation fees" are added at checkout.\n\n3. Quality & Regulatory Compliance\n\nCrucial for building trust and handling "Scam" or "Safety" objections.	2026-03-25 06:03:49.829159	2026-03-25 06:03:49.829159
4	1	product_info	Knowledge Base (KB) for G4U generics sales (part 2 of 2)	FDA/GMP Standards: All generics are manufactured in facilities that adhere to Good Manufacturing Practices (GMP).\n\nBioequivalence: By law, generics must have the same active ingredient, strength, and dosage form as the brand-name drug.\n\nTesting: Every batch undergoes third-party lab testing for purity and potency.\n\n4. Shipping & Stealth Protocol\n\nTo address the "discreet" nature of the service.\n\nPlain Packaging: Orders are shipped in standard USPS/UPS/FedEx mailers with no mention of "Pharmacy," "Generics4You," or medication names.\n\nSender Name: The return address uses a neutral holding company name (e.g., "G4Y Logistics").\n\nTracking: Every order includes a private tracking link sent via encrypted email/SMS.\n\n5. Frequently Asked Questions (Agent Cheat Sheet)\n\n"Why is it so cheap?" → "We cut out the middleman and the high marketing costs of big pharmaceutical brands, passing those savings directly to you."\n\n"Do I need a new prescription?" → "If you have a valid prescription on file with us or another pharmacy, we can transfer it. If it's expired, our medical team can review your history for a renewal."\n\n"How long does it take?" → "Standard shipping is 3-5 business days. We also offer overnight shipping if you're running low."	2026-03-25 06:03:49.838055	2026-03-25 06:03:49.838055
5	1	product_info	G4U upgrade - Mar 2026 (part 1 of 4)	US‑market–specific lead‑generation playbook for generic medications, while staying FDA, FTC, \nHIPAA, and pharmacy‑compliant. \n \n✅ Sureshot Lead Generation Strategies for Generic Meds (US D2C) \n1. Understand the Buyer Segments First (Critical) \nA. Uninsured / Underinsured (High-Intent, Price-Driven) \n18–64 years  \nChronic conditions (diabetes, hypertension, thyroid, cholesterol, asthma)  \nSearches are problem + cost driven  \nSwitching brands easily  \nTriggers \n“generic alternative to X”  \n“cheap medicine for ___”  \n“no insurance prescription cost”  \n \nB. Insured but Cost-Conscious (Convenience-Driven) \nHas insurance but: \nHigh deductibles  \nPoor pharmacy experience  \nWants auto-refill & home delivery  \nTriggers \n“copay too high”  \n“mail order pharmacy”  \n“cheaper than CVS/Walgreens”  \n \n2. Search Is Your #1 Money Channel (Non‑Negotiable) \n✅ High-Intent Google Search Strategy \nTarget keyword clusters \ngeneric vs brand drug \ncheapest generic for ___ \nno insurance prescription \nonline pharmacy generic \nmetformin price without insurance \nWhy it works \nSearchers already want the drug  \nNo education needed  \nConversion rates: 8–18% (industry norm)  \nExecution tips \nOne landing page per molecule (not per category)  \nPrice transparency above the fold  \nInsurance + No Insurance toggle  \n“Doctor sends Rx → We ship” clarity  \n✅ Works exceptionally well for: \nDiabetes meds	2026-03-25 06:05:23.081308	2026-03-25 06:05:23.081308
6	1	product_info	G4U upgrade - Mar 2026 (part 2 of 4)	BP meds  \nCholesterol  \nThyroid  \nMental health generics  \n \n3. Price Comparison Pages (Extremely Powerful) \n✅ “Compare & Save” Strategy \nCreate SEO + paid pages like: \n“Metformin Price Comparison – CVS vs Walgreens vs Online”  \n“Generic Viagra Cost Without Insurance”  \n“Top 5 Cheapest Pharmacies for ___”  \nWhy it converts \nUS consumers always comparison shop meds  \nGoogle ranks these pages fast  \nFTC‑safe if factual & sourced  \nCTA \n \n“Switch in 2 minutes – same FDA‑approved generic, lower price” \n \n \n4. Condition-Based Funnels (Instead of Drug-Based) \n✅ Condition First → Drug Later \nExample Funnel \nDiabetes Care Page \n↓ \nEducation (A1C, long-term cost) \n↓ \nGeneric Options (Metformin, Glipizide) \n↓ \nPrice & Delivery Comparison \n↓ \nPrescription Upload / Doctor Connect \nWhy this works \nAvoids aggressive “drug selling”  \nFDA‑compliant  \nBuilds trust  \nHigher LTV  \n \n5. Telehealth + Pharmacy Combo (Conversion Multiplier) \n✅ Lead Magnet: “Consult → Prescription → Delivery” \nFor uninsured \n$19–$29 consult  \nGeneric Rx included or discounted  \nFor insured	2026-03-25 06:05:23.090157	2026-03-25 06:05:23.090157
7	1	product_info	G4U upgrade - Mar 2026 (part 4 of 4)	Refill reminders  \nCondition education  \nGeneric alternatives to popular brands  \nSMS (with consent) \n“Your refill saves $28 this month”  \n“Price dropped for your medication”  \n Best channel for: \nChronic meds  \nAuto-refills  \nRetention > acquisition  \n \n9. Affiliate & Partner Channels (High Volume) \n✅ Best Partners \nInsurance comparison sites  \nHealth savings blogs  \nChronic condition communities  \nEmployer benefit platforms  \nGig worker platforms  \nOffer \nCost savings  \nRevenue share  \nWhite-labeled pharmacy option  \n \n10. Trust Is the Real Conversion Lever \n✅ Must-Have Trust Elements \nFDA approval explanation (simple language)  \nPharmacy license numbers  \nNABP / LegitScript seals  \nClear pharmacist support access  \nUS-based fulfillment clarity  \nCopy that converts \n \n“Same FDA‑approved generic you get at CVS – without the markup.” \n \n \n11. What NOT To Do (Costly Mistakes) \n❌ Aggressive drug claims  ❌ Hiding prices  ❌ Overusing coupon gimmicks  ❌ Competing \nonly on lowest price  ❌ Ignoring compliance language \n \n12. Ideal Funnel Blueprint (Sureshot) \nGoogle Search / SEO \n↓ \nCondition or Drug Landing Page \n↓\n\nPrice Transparency \n↓ \nInsurance / No Insurance Path \n↓ \nRx Upload or Teleconsult \n↓ \nAuto-Refill + Education \n↓ \nLTV via Email/SMS \n \nFinal Consultant Take \nIf you do only 3 things right, you’ll win: \nSearch-led acquisition  \nRadical price transparency  \nCondition-first education  \nGeneric meds are not a branding game — they’re a trust + economics game.	2026-03-25 06:05:23.09273	2026-03-25 06:05:23.09273
8	1	product_info	G4U upgrade - Mar 2026 (part 3 of 4)	Teleconsult convenience  \nAvoid PCP wait times  \nBest-performing offers \n“Doctor consult + generic meds starting at $X”  \n“No insurance? Talk to a doctor today”  \n⚠ Ensure: \nLicensed providers  \nState coverage compliance  \nClear medical disclaimers  \n \n6. Paid Social That Actually Works (Most People Fail Here) \n❌ What DOESN’T work \n“Buy cheap meds now”  \nDirect drug ads without education  \nGeneric brand creatives  \n✅ What DOES work \nA. Problem-Led Hooks \n“Why are Americans overpaying for generic meds?”  \n“No insurance? Still paying full price for prescriptions?”  \nB. Education Ads \nShort explainer videos  \nCost-saving myths  \nPharmacy markups  \nC. Retargeting Only \nUse paid social mainly for: \nSite visitors  \nSearch click retargeting  \nCart abandoners  \n✅ Facebook + Instagram = Retargeting ✅ TikTok = Education + awareness (younger \nuninsured) \n \n7. Local SEO + “Near Me” Hacks (Underused) \n✅ Rank for “Online Pharmacy Near Me” \nEven if D2C: \nCreate local landing pages for top US metros  \n“Serving Texas | California | Florida | NY”  \nBonus \nGoogle Business Profile (yes, even for online pharmacies)  \nReview generation = trust signals  \n \n8. Email & SMS: Where the Real Money Is \n✅ Post-Lead Monetization \nEmail sequences \nPrice drops	2026-03-25 06:05:23.092913	2026-03-25 06:05:23.092913
\.


--
-- Data for Name: users; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.users (id, replit_user_id, email, name, business_name, plan, created_at, updated_at) FROM stdin;
1	demo-user	\N	Demo User	\N	free	2026-03-24 10:31:40.823049	2026-03-24 10:31:40.823049
\.


--
-- Name: agent_configs_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.agent_configs_id_seq', 1, true);


--
-- Name: call_logs_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.call_logs_id_seq', 4, true);


--
-- Name: calling_scripts_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.calling_scripts_id_seq', 1, false);


--
-- Name: campaign_contacts_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.campaign_contacts_id_seq', 1, false);


--
-- Name: campaigns_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.campaigns_id_seq', 1, false);


--
-- Name: contacts_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.contacts_id_seq', 1, false);


--
-- Name: training_data_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.training_data_id_seq', 8, true);


--
-- Name: users_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.users_id_seq', 1, true);


--
-- Name: agent_configs agent_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.agent_configs
    ADD CONSTRAINT agent_configs_pkey PRIMARY KEY (id);


--
-- Name: agent_configs agent_configs_user_id_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.agent_configs
    ADD CONSTRAINT agent_configs_user_id_unique UNIQUE (user_id);


--
-- Name: call_logs call_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.call_logs
    ADD CONSTRAINT call_logs_pkey PRIMARY KEY (id);


--
-- Name: calling_scripts calling_scripts_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.calling_scripts
    ADD CONSTRAINT calling_scripts_pkey PRIMARY KEY (id);


--
-- Name: campaign_contacts campaign_contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.campaign_contacts
    ADD CONSTRAINT campaign_contacts_pkey PRIMARY KEY (id);


--
-- Name: campaigns campaigns_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.campaigns
    ADD CONSTRAINT campaigns_pkey PRIMARY KEY (id);


--
-- Name: contacts contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_pkey PRIMARY KEY (id);


--
-- Name: training_data training_data_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.training_data
    ADD CONSTRAINT training_data_pkey PRIMARY KEY (id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users users_replit_user_id_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_replit_user_id_unique UNIQUE (replit_user_id);


--
-- Name: agent_configs agent_configs_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.agent_configs
    ADD CONSTRAINT agent_configs_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: call_logs call_logs_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.call_logs
    ADD CONSTRAINT call_logs_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: calling_scripts calling_scripts_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.calling_scripts
    ADD CONSTRAINT calling_scripts_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: campaign_contacts campaign_contacts_campaign_id_campaigns_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.campaign_contacts
    ADD CONSTRAINT campaign_contacts_campaign_id_campaigns_id_fk FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id) ON DELETE CASCADE;


--
-- Name: campaigns campaigns_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.campaigns
    ADD CONSTRAINT campaigns_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: contacts contacts_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: training_data training_data_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.training_data
    ADD CONSTRAINT training_data_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict TERu35URFTWqD8JVWeH3Xev649ZN8s1llloThbGKxWUzGhryrF23Gu0X6dDs1dL

